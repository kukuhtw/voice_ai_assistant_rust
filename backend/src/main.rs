// backend/src/main.rs
/*
=============================================================================
Project : voice_ai_assistant_rust — real-time multimodal Voice AI in Rust
Module  : <module_name>.rs
Version : 0.5.0
Author  : Kukuh Tripamungkas Wicaksono (Kukuh TW)
Email   : kukuhtw@gmail.com
WhatsApp: https://wa.me/628129893706
LinkedIn: https://id.linkedin.com/in/kukuhtw
License : MIT (see LICENSE)

Summary : Menangkap audio mikrofon, melakukan STT streaming, memproses intent
          via LLM/NLU, mensintesis suara (TTS), serta menggerakkan avatar 3D
          (viseme/lip-sync) dengan latensi ujung-ke-ujung < 200 ms.


(c) 2025 Kukuh TW. All rights reserved where applicable.
=============================================================================
*/

use futures_util::TryStreamExt;
use std::{env, time::Duration};

use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use bytes::Bytes;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio_stream::Stream;
use tokio_util::io::StreamReader;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
};
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    openai_api_key: String,
    http: reqwest::Client,
}

#[derive(serde::Serialize)]
struct Health { ok: bool }

#[derive(serde::Serialize)]
struct EnvProbe {
    backend_port: u16,
    has_openai_key: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let openai_api_key = env::var("OPENAI_API_KEY").unwrap_or_default();
    let http = reqwest::Client::builder().build()?;
    let state = AppState { openai_api_key, http };

    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    let trace = TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().include_headers(true))
        .on_response(DefaultOnResponse::new().include_headers(true));

    let app = Router::new()
        .route("/health", get(|| async { Json(Health { ok: true }) }))
        .route("/debug/env", get(debug_env))
        .route("/debug/ping-openai", get(debug_ping_openai))
        .route("/api/stt", post(stt))
        .route("/api/ask", post(ask_stream))         // Chat Completions (lama)
        .route("/api/search", post(search_stream))   // ← NEW: Responses + web_search
        .route("/api/tts", post(tts_simple))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(cors)
        .layer(trace)
        .with_state(state.clone());

    let port = env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8080u16);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    println!("BOOT: audio_qa_avatar starting…");
    let listener = TcpListener::bind(addr).await?;
    println!("BOOT: audio_qa_avatar listening on {addr:?}");

    info!(%port, "starting axum server… OPENAI key present? {}", !state.openai_api_key.is_empty());

    async fn shutdown_signal() {
        use tokio::signal;
        let ctrl_c = async {
            signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
        };
        #[cfg(unix)]
        let terminate = async {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
            term.recv().await;
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();

        tokio::select! { _ = ctrl_c => {}, _ = terminate => {}, }
        tracing::info!("shutdown signal received");
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn debug_env() -> impl IntoResponse {
    let has_key = env::var("OPENAI_API_KEY").ok().map(|k| !k.is_empty()).unwrap_or(false);
    let port = env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8080u16);
    Json(EnvProbe { backend_port: port, has_openai_key: has_key })
}

async fn debug_ping_openai(State(state): State<AppState>) -> impl IntoResponse {
    let res = state.http
        .get("https://api.openai.com/v1/models")
        .bearer_auth(&state.openai_api_key)
        .send().await;

    match res {
        Ok(resp) => {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            Json(serde_json::json!({
                "ok": code.is_success(),
                "status": code.as_u16(),
                "body_head": &body[..body.len().min(300)],
            })).into_response()
        }
        Err(e) => {
            error!(err=%e, "debug_ping_openai error");
            (StatusCode::BAD_GATEWAY, format!("openai ping error: {e}")).into_response()
        }
    }
}

/* -------------------- STT -------------------- */

async fn stt(State(state): State<AppState>, mut mp: Multipart) -> impl IntoResponse {
    let mut audio_bytes: Option<Vec<u8>> = None;
    let mut filename: String = "audio.webm".to_string();

    while let Some(field) = mp.next_field().await.unwrap_or(None) {
        let name = field.name().unwrap_or("");
        if name == "audio" {
            if let Some(fname) = field.file_name() { filename = fname.to_string(); }
            let data = field.bytes().await.unwrap_or(Bytes::new());
            audio_bytes = Some(data.to_vec());
        }
    }

    let Some(bytes) = audio_bytes else {
        return (StatusCode::BAD_REQUEST, "missing audio").into_response()
    };

    let part_audio = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("audio/webm").unwrap();
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .part("file", part_audio);

    let res = state.http
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(&state.openai_api_key)
        .multipart(form)
        .send().await;

    match res {
        Ok(resp) => {
            if !resp.status().is_success() {
                let code = resp.status();
                let text = resp.text().await.unwrap_or_default();
                error!(%code, %text, "stt error");
                return (StatusCode::BAD_GATEWAY, text).into_response();
            }
            let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({"text":""}));
            Json(v).into_response()
        }
        Err(e) => {
            error!(err = %e, "stt http error");
            (StatusCode::BAD_GATEWAY, e.to_string()).into_response()
        }
    }
}

/* -------------------- ASK (Chat Completions, SSE teks + debug) -------------------- */

#[derive(serde::Deserialize)]
struct AskBody { prompt: String }

#[derive(serde::Deserialize)]
struct OAIStreamChoiceDelta { content: Option<String>, role: Option<String> }

#[derive(serde::Deserialize)]
struct OAIStreamChoice { delta: OAIStreamChoiceDelta, finish_reason: Option<String> }

#[derive(serde::Deserialize)]
struct OAIStreamChunk { choices: Vec<OAIStreamChoice> }

async fn ask_stream(
    State(state): State<AppState>,
    Json(body): Json<AskBody>
) -> Sse<impl Stream<Item = Result<Event, axum::Error>>> {
    let client = state.http.clone();
    let api_key = state.openai_api_key.clone();
    let prompt = body.prompt;

    let stream = async_stream::try_stream! {
        yield Event::default().event("progress").data("upstream: connecting");

        let req_body = serde_json::json!({
            "model": "gpt-4o-mini",
            "stream": true,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt}
            ]
        });

        let resp = client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&api_key)
            .json(&req_body)
            .send()
            .await
            .map_err(axum::Error::new)?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            error!(%status, body=%body, "ask upstream error");
            yield Event::default().event("error").data(format!("upstream {}", status));
            return;
        }

        yield Event::default().event("progress").data("upstream: connected");

        let mut full_text = String::new();

        let byte_stream = resp.bytes_stream().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let reader = BufReader::new(StreamReader::new(byte_stream));
        let mut lines = reader.lines();

        while let Some(line) = lines.next_line().await.map_err(axum::Error::new)? {
            if line.is_empty() { continue; }
            let Some(payload) = line.strip_prefix("data:").map(|s| s.trim()) else { continue; };
            if payload == "[DONE]" { break; }

            if let Ok(chunk) = serde_json::from_str::<OAIStreamChunk>(payload) {
                for choice in chunk.choices {
                    if let Some(delta) = choice.delta.content {
                        full_text.push_str(&delta);
                        yield Event::default().event("answer").data(delta);
                    }
                }
            }
        }

        let debug_json = serde_json::json!({
            "ok": true,
            "model": "gpt-4o-mini",
            "full_text_len": full_text.len(),
            "full_text_head": &full_text[..full_text.len().min(400)],
        });
        yield Event::default().event("debug").data(debug_json.to_string());
        yield Event::default().event("progress").data("done");
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"))
}

/* -------------------- SEARCH (Responses API + web_search, SSE teks + debug) -------------------- */

#[derive(serde::Deserialize)]
struct SearchBody { query: String }

async fn search_stream(
    State(state): State<AppState>,
    Json(body): Json<SearchBody>
) -> Sse<impl Stream<Item = Result<Event, axum::Error>>> {
    let client = state.http.clone();
    let api_key = state.openai_api_key.clone();
    let query = body.query;

    let stream = async_stream::try_stream! {
        yield Event::default().event("progress").data("upstream: connecting (responses+web_search)");

        let req_body = serde_json::json!({
            "model": "gpt-4.1-mini",          // model Responses API yang mendukung tools
            "input": format!(
                "Tolong cari di web tentang: {}.\nRingkas dalam bahasa Indonesia, sertakan 3 sumber (judul + URL).",
                query
            ),
            "tools": [ { "type": "web_search" } ],
            "tool_choice": "auto",
            "stream": true
        });

        let resp = client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&api_key)
            .json(&req_body)
            .send()
            .await
            .map_err(axum::Error::new)?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            error!(%status, body=%body, "search upstream error");
            yield Event::default().event("error").data(format!("upstream {}", status));
            return;
        }

        yield Event::default().event("progress").data("upstream: connected");

        let mut full_text = String::new();

        let byte_stream = resp.bytes_stream().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let reader = BufReader::new(StreamReader::new(byte_stream));
        let mut lines = reader.lines();

        while let Some(line) = lines.next_line().await.map_err(axum::Error::new)? {
            if line.is_empty() { continue; }
            let Some(payload) = line.strip_prefix("data:").map(|s| s.trim()) else { continue; };
            if payload == "[DONE]" { break; }

            // Responses API streaming: event payload adalah JSON per event.
            // Kita tarik hanya delta teks dari event "response.output_text.delta".
            // Abaikan event tool_call, reasoning, dll.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

                // Old fallback (kalau gateway masih mengirim choices delta)
                if v.get("choices").is_some() {
                    if let Ok(chunk) = serde_json::from_value::<OAIStreamChunk>(v.clone()) {
                        for choice in chunk.choices {
                            if let Some(delta) = choice.delta.content {
                                full_text.push_str(&delta);
                                yield Event::default().event("answer").data(delta);
                            }
                        }
                        continue;
                    }
                }

                // Responses API text delta
                if t == "response.output_text.delta" {
                    if let Some(delta) = v.get("delta").and_then(|x| x.as_str()) {
                        full_text.push_str(delta);
                        yield Event::default().event("answer").data(delta.to_string());
                    }
                }

                // Completed → tidak perlu apa-apa, loop berhenti saat dapat [DONE]
                // Error event
                if t == "response.error" {
                    let msg = v.get("error").and_then(|x| x.as_str()).unwrap_or("response.error");
                    yield Event::default().event("error").data(msg.to_string());
                }
            }
        }

        let debug_json = serde_json::json!({
            "ok": true,
            "model": "gpt-4.1-mini",
            "full_text_len": full_text.len(),
            "full_text_head": &full_text[..full_text.len().min(400)],
        });
        yield Event::default().event("debug").data(debug_json.to_string());
        yield Event::default().event("progress").data("done");
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"))
}

/* -------------------- TTS (simple) -------------------- */

#[derive(serde::Deserialize)]
struct TtsBody {
    text: String,
    #[serde(default)]
    voice: Option<String>, // ex: "alloy", "verse", "aria"
}

#[derive(serde::Serialize)]
struct TtsSimpleResponse { audio_base64: String }

async fn tts_simple(State(state): State<AppState>, Json(body): Json<TtsBody>) -> impl IntoResponse {
    let text = clip_tts_text(&body.text, 60_000);
    let voice = body.voice.as_deref().unwrap_or("alloy"); // default alloy

    let tts_req = serde_json::json!({
        "model": "gpt-4o-mini-tts",
        "voice": "alloy",
        "input": text,
        "format": "wav"
    });

    let mut last_err: Option<String> = None;
    for (i, backoff_ms) in [0u64, 400, 1200].into_iter().enumerate() {
        if i > 0 { tokio::time::sleep(Duration::from_millis(backoff_ms)).await; }

        match state.http
            .post("https://api.openai.com/v1/audio/speech")
            .bearer_auth(&state.openai_api_key)
            .header("Accept", "audio/wav")
            .json(&tts_req)
            .send().await
        {
            Ok(resp) if resp.status().is_success() => {
                let audio = resp.bytes().await.unwrap_or_default();
                let audio_b64 = base64::engine::general_purpose::STANDARD.encode(audio);
                return Json(TtsSimpleResponse { audio_base64: audio_b64 }).into_response();
            }
            Ok(resp) => {
                let code = resp.status();
                let body = resp.text().await.unwrap_or_default();
                last_err = Some(format!("tts error {code}: {body}"));
                if !code.is_server_error() {
                    return (StatusCode::BAD_GATEWAY, last_err.unwrap()).into_response();
                }
            }
            Err(e) => { last_err = Some(format!("tts http error: {e}")); }
        }
    }

    (StatusCode::BAD_GATEWAY, last_err.unwrap_or_else(|| "tts failed".into())).into_response()
}

fn clip_tts_text(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let cut = s.char_indices()
        .take_while(|(i, _)| *i <= max)
        .map(|(i, _)| i)
        .last()
        .unwrap_or(max);
    let mut out = s[..cut].trim_end().to_string();
    out.push_str(" …");
    out
}
