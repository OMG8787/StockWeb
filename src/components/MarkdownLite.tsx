import type { ReactNode } from "react";

/**
 * Renders the small subset of Markdown the AI chat/brief actually produces
 * (bold `**text**`, `*`/`-` bullet lines, blank-line paragraph breaks) as
 * real HTML instead of literal asterisks. Not a general Markdown parser —
 * a full library (react-markdown + remark) would be overkill for output
 * this constrained, and this project prefers small hand-rolled formatting
 * (see lib/format.ts) over pulling in a parsing ecosystem for one text
 * style. Unrecognized syntax just passes through as plain text, which is a
 * safe degradation.
 */
export interface MarkdownStock {
  symbol: string;
  name: string;
}

/**
 * stocks／stockPrefix：文字裡出現「名稱(代號)」的地方，在前面插入 stockPrefix(stock)（例如 ☆ 加入關注按鈕，
 * 2026-10-12 使用者：AI 建議區每個股票前面都要有一顆星）。只比對傳進來的已知股票，不猜測名稱邊界。
 */
export default function MarkdownLite({
  text,
  stocks,
  stockPrefix,
}: {
  text: string;
  stocks?: MarkdownStock[];
  stockPrefix?: (s: MarkdownStock) => ReactNode;
}) {
  const render = (s: string) => renderInline(s, stocks, stockPrefix);
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="list-disc space-y-0.5 pl-4">
        {listBuffer.map((item, i) => (
          <li key={i}>{render(item)}</li>
        ))}
      </ul>
    );
    listBuffer = [];
  }

  lines.forEach((line, i) => {
    const bulletMatch = line.match(/^\s*[*-]\s+(.*)/);
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1]);
      return;
    }
    flushList();
    if (line.trim() === "") {
      if (i > 0 && i < lines.length - 1) blocks.push(<div key={`sp-${i}`} className="h-2" />);
    } else {
      blocks.push(<p key={`p-${i}`}>{render(line)}</p>);
    }
  });
  flushList();

  return <>{blocks}</>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把一段純文字裡的「名稱(代號)」前面插入 prefix；其餘原樣 */
function withStockPrefix(text: string, stocks: MarkdownStock[] | undefined, prefix: ((s: MarkdownStock) => ReactNode) | undefined, keyBase: string): ReactNode[] {
  if (!stocks || stocks.length === 0 || !prefix) return [text];
  const byToken = new Map(stocks.map((s) => [`${s.name}(${s.symbol})`, s]));
  const re = new RegExp(`(${[...byToken.keys()].map(escapeRe).join("|")})`, "g");
  return text.split(re).flatMap<ReactNode>((part, i) => {
    const s = byToken.get(part);
    return s ? [<span key={`${keyBase}-${i}`} className="whitespace-nowrap">{prefix(s)}{part}</span>] : part ? [part] : [];
  });
}

function renderInline(text: string, stocks?: MarkdownStock[], prefix?: (s: MarkdownStock) => ReactNode): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{withStockPrefix(part.slice(2, -2), stocks, prefix, `b${i}`)}</strong>;
    }
    return withStockPrefix(part, stocks, prefix, `t${i}`);
  });
}
