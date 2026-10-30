fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "secure-store",
            tauri_build::InlinedPlugin::new()
                .commands(&["available", "get", "set", "delete"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
