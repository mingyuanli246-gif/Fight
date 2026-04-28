import { useEffect, useRef, useState } from "react";
import { ensureResourceDirectories } from "../features/notebooks/resourceCommands";
import type { NoteOpenRequest, NoteOpenTarget } from "../features/notebooks/types";
import { maybeRunAutoBackup } from "../features/settings/commands";
import type { SettingsNotice } from "../features/settings/types";
import { ThemeProvider } from "../features/theme/ThemeProvider";
import AppShell from "./layout/AppShell";
import type { AppSection } from "./sections";

function App() {
  const [currentSection, setCurrentSection] = useState<AppSection>("notebooks");
  const [noteOpenRequest, setNoteOpenRequest] = useState<NoteOpenRequest | null>(
    null,
  );
  const [settingsStartupNotice, setSettingsStartupNotice] =
    useState<SettingsNotice | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await ensureResourceDirectories();
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("[resources] 资源目录初始化失败", error);
        setSettingsStartupNotice({
          tone: "error",
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "初始化资源目录失败，请稍后重试。",
        });
        return;
      }

      try {
        const result = await maybeRunAutoBackup();

        if (cancelled) {
          return;
        }

        if (result.status === "created" && result.backup) {
          console.info("[settings] 自动备份已创建", result.backup.fileName);
          return;
        }

        if (result.warning) {
          setSettingsStartupNotice({
            tone: "warning",
            message: result.warning,
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("[settings] 自动备份检查失败", error);
        setSettingsStartupNotice({
          tone: "error",
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "自动备份检查失败，请稍后重试。",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleOpenNote(target: NoteOpenTarget) {
    requestIdRef.current += 1;
    setCurrentSection("notebooks");
    setNoteOpenRequest({
      requestId: requestIdRef.current,
      ...target,
    });
  }

  function handleConsumeNoteOpenRequest(requestId: number) {
    setNoteOpenRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }

  return (
    <ThemeProvider>
      <AppShell
        currentSection={currentSection}
        onSectionChange={setCurrentSection}
        noteOpenRequest={noteOpenRequest}
        onConsumeNoteOpenRequest={handleConsumeNoteOpenRequest}
        onOpenNote={handleOpenNote}
        settingsStartupNotice={settingsStartupNotice}
      />
    </ThemeProvider>
  );
}

export default App;
