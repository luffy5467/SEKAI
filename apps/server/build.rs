// `sqlx::migrate!` embeds the migrations directory at compile time. Without
// this, adding a migration file does not trigger a rebuild, and the server
// silently starts without it.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
