import styles from "./PageLayout.module.css";

export function TagPlazaPage() {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>标签广场</p>
        <h2 className={styles.title}>标签结构与复习入口占位</h2>
        <p className={styles.description}>
          这一页先验证标签视图的布局感，后续再引入标签系统、关联笔记和复习区逻辑。
        </p>
      </header>

      <div className={styles.gridTwo}>
        <section className={styles.surfaceMuted}>
          <h3 className={styles.surfaceTitle}>标签列表</h3>
          <div className={styles.badgeRow}>
            <span className={styles.badge}>学习方法</span>
            <span className={styles.badge}>项目管理</span>
            <span className={styles.badge}>长期复习</span>
            <span className={styles.badge}>阅读摘录</span>
            <span className={styles.badge}>待整理</span>
            <span className={styles.badge}>知识框架</span>
          </div>
        </section>

        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>标签说明</h3>
          <p className={styles.surfaceText}>
            用于展示当前标签的说明、使用规则和复习优先级提示。第一阶段只保留内容位置与层次。
          </p>
        </section>
      </div>

      <div className={styles.gridTwo}>
        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>关联笔记区</h3>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>标签下的文件列表</strong>
              <span>未来展示标题、摘要、更新时间与所属路径。</span>
            </li>
            <li className={styles.listItem}>
              <strong>筛选与排序区</strong>
              <span>未来可接入最近更新、复习优先级、标签交集等条件。</span>
            </li>
          </ul>
        </section>

        <section className={styles.surfaceMuted}>
          <h3 className={styles.surfaceTitle}>复习区预留</h3>
          <p className={styles.surfaceText}>
            如果后续将“标签广场”演化为“标签广场 / 复习区”，这里可以承接复习入口与状态面板。
          </p>
        </section>
      </div>
    </section>
  );
}
