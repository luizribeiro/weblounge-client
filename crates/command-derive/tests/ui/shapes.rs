use weblounge_command_derive::Command;

#[derive(Command)]
struct NotAnEnum;

#[derive(Command)]
enum TupleVariant {
    #[command(
        name = "tuple",
        aliases = [],
        usage = "cmd.tuple.usage",
        description = "cmd.tuple.description",
        surfaces = ["Slash"]
    )]
    Tuple(String),
}

fn main() {}
