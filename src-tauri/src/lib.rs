mod database_ops;
mod resource_ops;
mod settings_backup;
mod window_state;

use database_ops::{
    activate_note_review_schedule_tx, add_tag_to_note_by_name_tx,
    cleanup_expired_review_schedules_tx, cleanup_expired_trash_tx,
    cleanup_unreferenced_managed_resources, clear_note_review_schedule_tx,
    clear_notebook_cover_image_tx, create_folder_tx, create_note_tx, create_notebook_tx,
    delete_folder_tx, delete_note_tx, delete_notebook_tx, duplicate_note_above_tx,
    ensure_note_search_ready, ensure_notebook_tree_constraints_tx, ensure_review_feature_ready_tx,
    get_note_review_schedule_tx, list_trash_roots_tx, move_folder_to_notebook_top_tx,
    move_folder_to_trash_tx, move_note_to_trash_tx, move_note_tx, move_notebook_to_trash_tx,
    purge_trashed_item_tx, remove_tag_from_note_tx, rename_note_tx, reorder_folders_tx,
    reorder_notebooks_tx, restore_trashed_item_tx, save_note_content_with_tags_tx,
    save_note_review_schedule_tx, set_note_review_schedule_dirty_tx, update_note_content_tx,
    update_notebook_cover_image_tx,
};
use resource_ops::{
    clear_managed_resource_session_leases, delete_managed_resource, ensure_resource_directories,
    list_resource_trash_items, permanently_delete_resource_trash_item,
    replace_managed_resource_session_leases, resolve_managed_resource, restore_resource_trash_item,
    select_and_import_image, ManagedResourceLeaseState,
};
use settings_backup::{
    create_backup, delete_backup, get_data_environment_info, list_backups, load_app_settings,
    maybe_run_auto_backup, open_backups_directory, open_data_directory, preview_restore_backup,
    recover_incomplete_restore_if_needed, restore_backup, save_app_settings,
    select_restore_backup_file, BackupOperationLock,
};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};
use window_state::{
    apply_saved_or_default_window_state, save_main_window_state, show_and_focus_main_window,
    WindowLifecycleState,
};

const MAIN_WINDOW_LABEL: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_note_search_fts",
            sql: include_str!("../migrations/0002_note_search_fts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_note_tags_tables",
            sql: include_str!("../migrations/0003_note_tags.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_review_schedule_tables",
            sql: include_str!("../migrations/0004_review_schedule.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create_app_meta_table",
            sql: include_str!("../migrations/0005_app_meta.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_custom_ordering_columns",
            sql: include_str!("../migrations/0006_custom_ordering.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "create_note_tag_occurrences_table",
            sql: include_str!("../migrations/0007_tag_occurrences.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_note_tag_occurrence_remark",
            sql: include_str!("../migrations/0008_note_tag_occurrence_remark.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_soft_delete_trash_columns",
            sql: include_str!("../migrations/0009_soft_delete_trash.sql"),
            kind: MigrationKind::Up,
        },
    ];

    let app = tauri::Builder::default()
        .manage(BackupOperationLock::default())
        .manage(ManagedResourceLeaseState::default())
        .manage(WindowLifecycleState::default())
        .setup(|app| {
            println!("[window] setup: begin");
            recover_incomplete_restore_if_needed(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;

            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                println!("[window] setup: found main window");
                #[cfg(target_os = "macos")]
                {
                    if let Err(error) = apply_saved_or_default_window_state(app.handle(), &window) {
                        eprintln!("[window] setup: failed to apply window state: {error}");
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_size(PhysicalSize::new(1440, 900));
                }
            } else {
                eprintln!("[window] setup: main window not found");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                println!("[window] event: received CloseRequested for main window");
                let lifecycle_state = window.state::<WindowLifecycleState>();
                if lifecycle_state.is_quitting() {
                    println!(
                        "[window] event: app is quitting, allow close request to continue without hide"
                    );
                    return;
                }

                if let Some(main_window) = window.app_handle().get_webview_window(MAIN_WINDOW_LABEL)
                {
                    if let Err(error) = save_main_window_state(window.app_handle(), &main_window) {
                        eprintln!("[window] event: save before hide failed: {error}");
                    } else {
                        println!("[window] event: save before hide success");
                    }
                } else {
                    eprintln!("[window] event: main webview window not found, skip save before hide");
                }

                println!("[window] event: calling prevent_close");
                api.prevent_close();
                println!("[window] event: prevent_close invoked");

                println!("[window] event: calling hide");
                match window.hide() {
                    Ok(_) => println!("[window] event: hide success"),
                    Err(error) => eprintln!("[window] event: hide failed: {error}"),
                }
            }
        })
        .on_menu_event(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if event.id() == "quit" {
                println!("[window] menu: quit requested, mark app as quitting");
                app_handle.state::<WindowLifecycleState>().mark_quitting();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            get_data_environment_info,
            open_data_directory,
            open_backups_directory,
            ensure_note_search_ready,
            ensure_notebook_tree_constraints_tx,
            create_note_tx,
            create_folder_tx,
            create_notebook_tx,
            ensure_review_feature_ready_tx,
            get_note_review_schedule_tx,
            cleanup_expired_review_schedules_tx,
            activate_note_review_schedule_tx,
            save_note_review_schedule_tx,
            clear_note_review_schedule_tx,
            set_note_review_schedule_dirty_tx,
            reorder_notebooks_tx,
            reorder_folders_tx,
            move_note_tx,
            move_folder_to_notebook_top_tx,
            duplicate_note_above_tx,
            delete_notebook_tx,
            delete_folder_tx,
            update_notebook_cover_image_tx,
            clear_notebook_cover_image_tx,
            rename_note_tx,
            update_note_content_tx,
            save_note_content_with_tags_tx,
            delete_note_tx,
            move_note_to_trash_tx,
            move_folder_to_trash_tx,
            move_notebook_to_trash_tx,
            list_trash_roots_tx,
            restore_trashed_item_tx,
            purge_trashed_item_tx,
            cleanup_expired_trash_tx,
            cleanup_unreferenced_managed_resources,
            add_tag_to_note_by_name_tx,
            remove_tag_from_note_tx,
            ensure_resource_directories,
            resolve_managed_resource,
            select_and_import_image,
            delete_managed_resource,
            replace_managed_resource_session_leases,
            clear_managed_resource_session_leases,
            list_resource_trash_items,
            restore_resource_trash_item,
            permanently_delete_resource_trash_item,
            list_backups,
            select_restore_backup_file,
            preview_restore_backup,
            create_backup,
            delete_backup,
            maybe_run_auto_backup,
            restore_backup,
        ])
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:fight-notes.db", migrations)
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { code, .. } => {
            #[cfg(target_os = "macos")]
            {
                println!("[window] quit: ExitRequested code={code:?}");
                app_handle.state::<WindowLifecycleState>().mark_quitting();
                if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    if let Err(error) = save_main_window_state(app_handle, &window) {
                        eprintln!("[window] quit: save before quit failed: {error}");
                    } else {
                        println!("[window] quit: save before quit success");
                    }
                } else {
                    eprintln!("[window] quit: main window not found, skip save");
                }
                println!("[window] quit: allowing normal app exit");
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            println!("[window] macos reopen: has_visible_windows={has_visible_windows}");
            show_and_focus_main_window(app_handle, "macos reopen");
        }
        _ => {}
    });
}
