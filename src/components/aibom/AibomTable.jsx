import Value from "../common/Value.jsx";

/** Field / value / status table used for the evidence-document node summary. */
export default function AibomTable({ section }) {
  return (
    <section className="aibom-section">
      <h4>{section.title}</h4>
      <div className="aibom-table-wrap">
        <table className="aibom-table">
          <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>
          <tbody>{section.rows.map((entry) => (
            <tr key={entry.field}>
              <th scope="row">{entry.field}</th>
              <td><Value value={entry.value} /></td>
              <td><span className={`status-pill status-${entry.status.toLowerCase().replaceAll(" ", "-")}`}>{entry.status}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}
