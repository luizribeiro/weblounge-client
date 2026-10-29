//! Compiler-level coverage for rejected command declarations.

#[test]
fn invalid_command_declarations_fail_to_compile() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}
