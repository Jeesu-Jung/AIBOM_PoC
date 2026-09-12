import { formatDate } from "../../utils/format.js";

export default function DashboardHeader({ metrics, familyIndex, nodeCount }) {
  const metaItems = [
    ["Families", familyIndex.summary.familyCount],
    ["Loaded nodes", nodeCount],
    ["Latest root release", formatDate(familyIndex.summary.latestRelease)]
  ];

  return (
    <>
      <header className="hero">
        <p className="eyebrow">Delta AIBOM example</p>
        <div className="hero-row">
          <div className="hero-copy">
            <h1 id="hero-title">Foundation-model lineage explorer</h1>
            <p className="lede" id="hero-lede">Compare multiple foundation-model families on one page and inspect the full AIBOM for any root or downstream node.</p>
          </div>
          <div className="hero-meta" id="hero-meta">
            {metaItems.map(([label, value]) => (
              <div className="meta-pill" key={label}>
                <span className="meta-label">{label}</span>
                <span className="meta-value">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      <section className="metrics" id="metrics" aria-label="Summary metrics">
        {metrics.map(([label, value]) => (
          <article className="metric-card" key={label}>
            <span className="metric-value">{value}</span>
            <span className="metric-label">{label}</span>
          </article>
        ))}
      </section>
    </>
  );
}
