import styles from "./PageLayout.module.css";

const calendarPreview = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

export function ReviewCalendarPage() {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>复习日历</p>
        <h2 className={styles.title}>复习节奏总览</h2>
        <p className={styles.description}>
          当前阶段只保留日历与任务信息的空间结构，用来验证桌面布局稳定性，不接入任何实际复习任务数据。
        </p>
      </header>

      <div className={styles.gridTwo}>
        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>月历占位</h3>
          <div className={styles.calendar}>
            {calendarPreview.map((day, index) => (
              <div key={day} className={styles.calendarCell}>
                <strong>{day}</strong>
                <span>{index + 7} 日</span>
                <span>复习入口预留</span>
              </div>
            ))}
          </div>
        </section>

        <div className={styles.stack}>
          <section className={styles.surfaceMuted}>
            <h3 className={styles.surfaceTitle}>今日任务</h3>
            <ul className={styles.list}>
              <li className={styles.listItem}>
                <strong>待复习笔记区域</strong>
                <span>后续接入日历任务列表与到期提醒。</span>
              </li>
              <li className={styles.listItem}>
                <strong>计划说明区域</strong>
                <span>显示今日节奏、优先级与完成状态。</span>
              </li>
            </ul>
          </section>

          <section className={styles.surface}>
            <h3 className={styles.surfaceTitle}>日历侧栏</h3>
            <p className={styles.surfaceText}>
              这里后续会接入选中日期的任务概览、复习频率说明与状态汇总。
            </p>
          </section>
        </div>
      </div>

      <div className={styles.gridStats}>
        <section className={styles.surface}>
          <p className={styles.metricValue}>0</p>
          <p className={styles.metricLabel}>今日复习任务占位</p>
        </section>
        <section className={styles.surface}>
          <p className={styles.metricValue}>0</p>
          <p className={styles.metricLabel}>本周完成占位</p>
        </section>
        <section className={styles.surface}>
          <p className={styles.metricValue}>0</p>
          <p className={styles.metricLabel}>待安排计划占位</p>
        </section>
      </div>
    </section>
  );
}
