# backend/Dockerfile
# backend/Dockerfile
FROM rust:1.83 AS builder
WORKDIR /app

# (opsional) stabilin jaringan
ENV CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false CARGO_NET_GIT_FETCH_WITH_CLI=true GIT_HTTP_VERSION=HTTP/1.1
RUN mkdir -p /root/.cargo && printf '%s\n' "\
[registries.crates-io]\nprotocol = \"sparse\"\n[net]\nretry = 10\ngit-fetch-with-cli = true\n[http]\nmultiplexing = false\n" > /root/.cargo/config.toml

COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release --verbose

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/target/release/audio_qa_avatar /app/audio_qa_avatar
RUN chmod +x /app/audio_qa_avatar
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/audio_qa_avatar"]
