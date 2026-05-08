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

    </aside>
  );
}
