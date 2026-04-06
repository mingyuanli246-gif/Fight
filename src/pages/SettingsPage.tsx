import { useContext, type CSSProperties } from "react";
import { ThemeContext } from "../features/theme/ThemeProvider";
import { themeOptions } from "../features/theme/themeOptions";
import styles from "./PageLayout.module.css";
import themeStyles from "./SettingsPage.module.css";

export function SettingsPage() {
  const themeContext = useContext(ThemeContext);

  if (!themeContext) {
    throw new Error("ThemeContext 未初始化");
  }

  const { theme, setTheme } = themeContext;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>设置</p>
        <h2 className={styles.title}>主题与本地工作区设置</h2>
        <p className={styles.description}>
          第一阶段只开放主题切换，用来验证变量体系与桌面布局的稳定性。其余设置项只保留结构，不接入持久化和系统逻辑。
        </p>
      </header>

      <section className={styles.surface}>
        <h3 className={styles.surfaceTitle}>主题切换</h3>
        <div className={themeStyles.themeGrid}>
          {themeOptions.map((option) => {
            const previewStyle = {
              "--preview-rail": option.preview.rail,
              "--preview-accent": option.preview.accent,
              "--preview-background": option.preview.background,
              "--preview-surface": option.preview.surface,
            } as CSSProperties;

            return (
              <button
                key={option.name}
                type="button"
                className={`${themeStyles.themeButton} ${
                  theme === option.name ? themeStyles.themeButtonActive : ""
                }`}
                onClick={() => setTheme(option.name)}
              >
                <div className={themeStyles.themeMeta}>
                  <p className={themeStyles.themeLabel}>{option.label}</p>
                  <p className={themeStyles.themeDescription}>
                    {option.description}
                  </p>
                </div>
                <div className={themeStyles.themePreview} style={previewStyle}>
                  <div className={themeStyles.themePreviewRail} />
                  <div className={themeStyles.themePreviewContent}>
                    <div className={themeStyles.themePreviewLine} />
                    <div
                      className={`${themeStyles.themePreviewLine} ${themeStyles.themePreviewLineShort}`}
                    />
                    <div className={themeStyles.themePreviewCard} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <div className={styles.gridTwo}>
        <section className={styles.surfaceMuted}>
          <h3 className={styles.surfaceTitle}>本地工作区</h3>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>数据存储</strong>
              <span>后续接入 SQLite 与本地资源目录管理。</span>
            </li>
            <li className={styles.listItem}>
              <strong>图片与封面</strong>
              <span>后续统一落在本地工作区目录，不接入云端。</span>
            </li>
          </ul>
        </section>

        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>后续预留</h3>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>备份与导出</strong>
              <span>本阶段不实现，只保留入口空间。</span>
            </li>
            <li className={styles.listItem}>
              <strong>数据目录配置</strong>
              <span>本阶段不实现，只验证桌面设置页结构。</span>
            </li>
          </ul>
        </section>
      </div>
    </section>
  );
}
