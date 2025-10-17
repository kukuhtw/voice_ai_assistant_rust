fn main() {
    println!("=== Rust Binary Started ===");
    println!("PORT: {}", std::env::var("PORT").unwrap_or("8080".to_string()));
    println!("Has OPENAI_API_KEY: {}", std::env::var("OPENAI_API_KEY").is_ok());
    println!("Exiting normally");
}