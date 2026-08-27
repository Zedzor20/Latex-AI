/** Shared colored renderer for unified-diff text (add / remove / hunk lines). */
export function DiffLines({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="diffCode">
      {lines.map((line, index) => {
        let className = "diffLine";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) className += " hunk";
        else if (line.startsWith("+")) className += " add";
        else if (line.startsWith("-")) className += " remove";
        return (
          <div key={index} className={className}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}
