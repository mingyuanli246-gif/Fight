import styles from "./PageLayout.module.css";

export function NotebooksPage() {
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>笔记本</p>
        <h2 className={styles.title}>笔记结构工作区</h2>
        <p className={styles.description}>
          这一页只建立未来笔记系统的结构感，不接入数据库与编辑器。后续会在这个骨架上继续承载
          “笔记本 - 文件夹 - 文件” 的核心层级。
        </p>
      </header>

      <div className={styles.gridThree}>
        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>笔记本列表</h3>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>长期资料库</strong>
              <span>用于沉淀稳定知识与长期复习内容。</span>
            </li>
            <li className={styles.listItem}>
              <strong>项目笔记</strong>
              <span>面向当前阶段任务与阶段性决策。</span>
            </li>
            <li className={styles.listItem}>
              <strong>碎片收集</strong>
              <span>面向临时想法、待整理记录与快速输入。</span>
            </li>
          </ul>
        </section>

        <section className={styles.surfaceMuted}>
          <h3 className={styles.surfaceTitle}>文件夹树</h3>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>产品规划</strong>
              <span>信息架构、阶段计划、版本目标。</span>
            </li>
            <li className={styles.listItem}>
              <strong>阅读摘录</strong>
              <span>书籍、课程、文章的结构化整理。</span>
            </li>
            <li className={styles.listItem}>
              <strong>复习材料</strong>
              <span>后续用于接入复习计划与日历任务入口。</span>
            </li>
          </ul>
        </section>

        <section className={styles.surface}>
          <h3 className={styles.surfaceTitle}>笔记内容区</h3>
          <p className={styles.surfaceText}>
            第一阶段只保留内容区的位置、边距和信息密度，不实现编辑、格式化和多媒体能力。
          </p>
          <div className={styles.badgeRow}>
            <span className={styles.badge}>本地优先</span>
            <span className={styles.badge}>结构清晰</span>
            <span className={styles.badge}>后续接入 FTS5</span>
          </div>
          <ul className={styles.list}>
            <li className={styles.listItem}>
              <strong>标题区域</strong>
              <span>用于显示当前文件标题、更新时间与所属层级。</span>
            </li>
            <li className={styles.listItem}>
              <strong>正文画布</strong>
              <span>后续接入富文本编辑器与 Markdown 快捷键。</span>
            </li>
            <li className={styles.listItem}>
              <strong>侧边信息</strong>
              <span>未来可扩展标签、复习计划、附件等信息面板。</span>
            </li>
          </ul>
        </section>
      </div>
    </section>
  );
}
