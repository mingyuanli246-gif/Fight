import type { AppSection } from "../../app/sections";
import { navigationItems } from "./navigationItems";
import styles from "./NavigationRail.module.css";

interface NavigationRailProps {
  currentSection: AppSection;
  onSectionChange: (section: AppSection) => void;
  disabled?: boolean;
}

export function NavigationRail({
  currentSection,
  onSectionChange,
  disabled = false,
}: NavigationRailProps) {
  return (
    <aside className={styles.rail}>
      <div className={styles.brand}>
        <p className={styles.eyebrow}>本地优先</p>
        <h1 className={styles.title}>本地笔记</h1>
        <p className={styles.subtitle}>长期自用 · 本地知识工作台</p>
      </div>

      <nav className={styles.navigation} aria-label="主导航">
        {navigationItems.map(({ key, label, Icon }) => {
          const isActive = currentSection === key;

          return (
            <button
              key={key}
              type="button"
              className={`${styles.item} ${isActive ? styles.itemActive : ""}`}
              disabled={disabled}
              onClick={() => onSectionChange(key)}
            >
              <Icon className={styles.icon} />
              <span className={styles.label}>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <p className={styles.footerLabel}>当前阶段</p>
        <p className={styles.footerValue}>稳定性封板与编辑器前置</p>
      </div>
    </aside>
  );
}
