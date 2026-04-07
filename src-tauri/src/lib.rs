mod database_ops;
mod settings_backup;

use database_ops::{
    add_tag_to_note_by_name_tx, bind_review_plan_to_note_tx, create_note_tx,
    create_review_plan_tx, delete_folder_tx, delete_note_tx, delete_notebook_tx,
    ensure_note_search_ready, rebuild_note_search_index, remove_review_plan_binding_tx,
    remove_tag_from_note_tx, rename_note_tx, update_note_content_tx,
};
use settings_backup::{
    create_backup, get_data_environment_info, list_backups, load_app_settings,
    maybe_run_auto_backup, restore_backup, save_app_settings, BackupOperationLock,
};
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create_initial_tables",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }, Migration {
        version: 2,
        description: "create_note_search_fts",
        sql: include_str!("../migrations/0002_note_search_fts.sql"),
        kind: MigrationKind::Up,
    }, Migration {
        version: 3,
        description: "create_note_tags_tables",
        sql: include_str!("../migrations/0003_note_tags.sql"),
        kind: MigrationKind::Up,
    }, Migration {
        version: 4,
        description: "create_review_schedule_tables",
        sql: include_str!("../migrations/0004_review_schedule.sql"),
        kind: MigrationKind::Up,
    }, Migration {
        version: 5,
        description: "create_app_meta_table",
        sql: include_str!("../migrations/0005_app_meta.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .manage(BackupOperationLock::default())
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            get_data_environment_info,
            ensure_note_search_ready,
            rebuild_note_search_index,
            create_note_tx,
            create_review_plan_tx,
            delete_notebook_tx,
            delete_folder_tx,
            rename_note_tx,
            update_note_content_tx,
            delete_note_tx,
            add_tag_to_note_by_name_tx,
            remove_tag_from_note_tx,
            bind_review_plan_to_note_tx,
            remove_review_plan_binding_tx,
            list_backups,
            create_backup,
            maybe_run_auto_backup,
            restore_backup,
        ])
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:fight-notes.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
