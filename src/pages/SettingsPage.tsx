import { SettingsWorkspace } from "../features/settings/SettingsWorkspace";
import type { SettingsNotice } from "../features/settings/types";
import styles from "./PageLayout.module.css";

interface SettingsPageProps {
  startupNotice: SettingsNotice | null;
}

export function SettingsPage({ startupNotice }: SettingsPageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>设置</p>
        <h2 className={styles.title}>本地数据、主题与备份恢复</h2>
        <p className={styles.description}>
          当前阶段已经接入主题持久化、手动备份、自动备份策略和备份恢复。这里负责查看本地数据环境，并完成最小可用的备份闭环。
        </p>
      </header>

      <SettingsWorkspace startupNotice={startupNotice} />
    </section>
  );
}
