use weblounge_command_derive::Command;

macro_rules! command {
    ($enum_name:ident, $($metadata:tt)*) => {
        #[derive(Command)]
        enum $enum_name {
            #[command(
                name = "test", aliases = [], usage = "cmd.test.usage",
                description = "cmd.test.description", surfaces = ["Slash"],
                $($metadata)*
            )]
            Test {},
        }
    };
}

command!(DuplicateKey, confirm = "Menu", confirm = "Always");

#[derive(Command)]
enum UppercaseName {
    #[command(
        name = "Test", aliases = [], usage = "cmd.test.usage",
        description = "cmd.test.description", surfaces = ["Slash"]
    )]
    Test {},
}

#[derive(Command)]
enum UppercaseAlias {
    #[command(
        name = "test", aliases = ["T"], usage = "cmd.test.usage",
        description = "cmd.test.description", surfaces = ["Slash"]
    )]
    Test {},
}

command!(BadPermission, permission = "Founder");
command!(BadConfirm, confirm = "Sometimes");

#[derive(Command)]
enum BadSurface {
    #[command(
        name = "test", aliases = [], usage = "cmd.test.usage",
        description = "cmd.test.description", surfaces = ["Dialog"]
    )]
    Test {},
}

fn main() {}
