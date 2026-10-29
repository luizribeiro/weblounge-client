use weblounge_command_derive::Command;

#[derive(Command)]
enum DuplicateNames {
    #[command(
        name = "first",
        aliases = ["shared"],
        usage = "cmd.first.usage",
        description = "cmd.first.description",
        surfaces = ["Slash"]
    )]
    First {},
    #[command(
        name = "shared",
        aliases = [],
        usage = "cmd.second.usage",
        description = "cmd.second.description",
        surfaces = ["Slash"]
    )]
    Second {},
}

#[derive(Command)]
enum BadRequirement {
    #[command(
        name = "bad",
        aliases = [],
        usage = "cmd.bad.usage",
        description = "cmd.bad.description",
        requires = ["Capability:account-tag"],
        surfaces = ["Slash"]
    )]
    Bad {},
}

fn main() {}
