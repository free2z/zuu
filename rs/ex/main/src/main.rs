extern crate lib;

fn main() {
    let hello = lib::Greeter::new("Hola,");
    hello.greet("world!! My friend");
}
