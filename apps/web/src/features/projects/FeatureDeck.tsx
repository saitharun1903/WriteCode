import { ArrowRight, Check, Play, X } from "lucide-react";
import type { ReactNode } from "react";
import { HOME_FEATURES } from "@/features/seo/pages";
import { cn } from "@/lib/cn";

/**
 * What the product does, as a deck of cards: each one stays put near the top
 * while the next slides over it, so scrolling turns them over one at a time,
 * on phones and tablets as on a computer. Each card shows the thing it talks
 * about, drawn small, rather than describing it.
 */
/** `top`: room kept above the cards for what stays at the top of the page while it scrolls. */
export function FeatureDeck({ top = 0 }: { top?: number }) {
  return (
    <ol className="mt-5">
      {HOME_FEATURES.map((f, i) => (
        <li key={f.slug} className="sticky mb-4" style={{ top: top + 12 + i * 10 }}>
          {/* A card fits the screen below what stays at the top, so all of it is seen before the next covers it. */}
          <article className="grid h-[min(510px,calc(100dvh-170px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_-6px_16px_-12px_rgb(0_0_0/0.25)] max-sm:[@media(max-height:640px)]:h-[300px] sm:h-[350px] lg:h-[310px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:grid-rows-1">
            <div className="flex flex-col p-5 sm:p-7">
              <p className="font-mono text-xs text-fg-subtle">
                <span className="text-accent-ink">{String(i + 1).padStart(2, "0")}</span> / {String(HOME_FEATURES.length).padStart(2, "0")} · {f.title}
              </p>
              <h3 className="mt-3 text-[22px] font-semibold leading-tight tracking-tight text-fg">{f.head}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-fg-muted">{f.text}</p>
              <a href={`/${f.slug}`} className="group mt-4 inline-flex items-center gap-1.5 self-start text-sm font-medium text-fg underline decoration-accent decoration-2 underline-offset-4 sm:mt-auto">
                {f.more}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </a>
            </div>
            <div className="min-h-0 p-4 pt-0 max-sm:[@media(max-height:640px)]:hidden sm:p-5 sm:pl-0">{DEMOS[f.slug]}</div>
          </article>
        </li>
      ))}
    </ol>
  );
}

/** A small window, like a panel of the editor. */
function Frame({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div aria-hidden className="cw-code cw-console flex h-full select-none flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-2 font-mono text-[12.5px] leading-[21px] text-fg">
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-line px-3 text-[11.5px] text-fg-subtle">
        <span className="truncate">{title}</span>
        {right}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden pb-2.5">{children}</div>
    </div>
  );
}

function Line({ n, children, className, dot }: { n: number; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <div className={cn("flex", className)}>
      <span className="relative w-9 shrink-0 pr-2.5 text-right text-fg-faint">
        {dot && <span className="absolute left-1.5 top-[6px] size-[9px] rounded-full bg-danger" />}
        {n}
      </span>
      <span className="whitespace-pre">{children}</span>
    </div>
  );
}

const K = ({ children }: { children: ReactNode }) => <span className="cw-tok-keyword">{children}</span>;
const N = ({ children }: { children: ReactNode }) => <span className="cw-tok-number">{children}</span>;
const C = ({ children }: { children: ReactNode }) => <span className="cw-tok-comment">{children}</span>;

const Rule = ({ children }: { children: ReactNode }) => <div className="mt-2 border-t border-line px-3 pt-1.5 text-[11px] uppercase tracking-wider text-fg-subtle">{children}</div>;

function RunDemo() {
  return (
    <Frame
      title="Main.java"
      right={
        <span className="flex items-center gap-1 rounded bg-success-soft px-1.5 py-px text-success">
          <Play className="size-2.5 fill-current" /> Run
        </span>
      }
    >
      <div className="pt-2">
        <Line n={1}>
          Scanner in = <K>new</K> Scanner(System.in);
        </Line>
        <Line n={2}>
          <K>int</K> n = in.nextInt();
        </Line>
        <Line n={3}>System.out.println(n * (n + <N>1</N>) / <N>2</N>);</Line>
      </div>
      <Rule>Console</Rule>
      <div className="px-3 pt-1">
        <div>
          <span className="text-success">5</span>
          <span className="ml-4 font-sans text-[11.5px] text-fg-faint">← you type this</span>
        </div>
        <div>15</div>
        <div className="text-fg-subtle">Process finished with exit code 0</div>
      </div>
    </Frame>
  );
}

function DebugDemo() {
  return (
    <Frame title="main.py" right={<span className="text-accent-ink">Paused on line 4</span>}>
      <div className="pt-2">
        <Line n={1}>
          total = <N>0</N>
        </Line>
        <Line n={2}>
          <K>for</K> i <K>in</K> range(<N>1</N>, <N>6</N>):
        </Line>
        <Line n={3}>
          {"    "}
          <C># add them up</C>
        </Line>
        <Line n={4} dot className="bg-[var(--execution-line)]">
          {"    "}total += i<span className="ml-5 italic text-fg-subtle">i = 3, total = 3</span>
        </Line>
        <Line n={5}>print(total)</Line>
      </div>
      <Rule>Variables</Rule>
      <div className="grid grid-cols-[auto_1fr] gap-x-6 px-3 pt-1">
        <span className="text-fg-muted">i</span>
        <N>3</N>
        <span className="text-fg-muted">total</span>
        <N>3</N>
      </div>
    </Frame>
  );
}

const CELLS = [3, 8, 1, 9, 4];
const POINTERS: Record<number, string> = { 1: "i", 3: "j" };

function VisualDemo() {
  return (
    <Frame title="Step 7 of 23" right={<span>swap(arr, i, j)</span>}>
      <div className="flex h-full flex-col justify-center gap-4 px-4 py-5">
        <div className="flex items-start gap-1.5">
          <span className="mt-2 w-8 text-fg-subtle">arr</span>
          {CELLS.map((value, at) => (
            <span key={at} className="flex w-10 flex-col items-center">
              <span className={cn("flex size-10 items-center justify-center rounded-md border text-sm", POINTERS[at] ? "border-accent bg-accent-soft font-semibold" : "border-line-strong")}>{value}</span>
              <span className="mt-0.5 text-[10.5px] text-fg-faint">{at}</span>
              <span className="h-4 text-[11.5px] font-semibold text-accent-ink">{POINTERS[at] ? `↑ ${POINTERS[at]}` : ""}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-subtle">
          <span className="mr-1">Call stack</span>
          <span className="rounded border border-line-strong px-1.5">main</span>
          <span>›</span>
          <span className="rounded border border-line-strong px-1.5">sort</span>
          <span>›</span>
          <span className="rounded border border-accent px-1.5 text-fg">swap</span>
        </div>
      </div>
    </Frame>
  );
}

const TESTS: { input: string; passed: boolean; note: string }[] = [
  { input: "5", passed: true, note: "15" },
  { input: "10", passed: true, note: "55" },
  { input: "0", passed: false, note: "expected 0, got 1" },
];

function TestsDemo() {
  return (
    <Frame title="Tests" right={<span>2 of 3 passed</span>}>
      <ul className="divide-y divide-line">
        {TESTS.map((t, i) => (
          <li key={i} className="flex items-center gap-2.5 px-3 py-2.5">
            <span className={cn("flex size-[18px] shrink-0 items-center justify-center rounded-full", t.passed ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
              {t.passed ? <Check className="size-3" /> : <X className="size-3" />}
            </span>
            <span className="font-sans text-[13px] font-medium">Test {i + 1}</span>
            <span className="text-fg-subtle">input {t.input}</span>
            <span className={cn("ml-auto truncate", t.passed ? "text-fg-muted" : "text-danger")}>{t.note}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

function Cursor({ name, color }: { name: string; color: string }) {
  return (
    <>
      <span className="-my-px inline-block h-[17px] w-0.5 translate-y-[3px]" style={{ background: color }} />
      <span className="mr-1 rounded-r rounded-tl px-1 py-px align-[2px] font-sans text-[10px] font-semibold leading-none text-white" style={{ background: color }}>
        {name}
      </span>
    </>
  );
}

const ASHA = "#e5484d";
const RAVI = "#30a46c";

function TogetherDemo() {
  return (
    <Frame
      title="main.py"
      right={
        <span className="flex items-center gap-1.5 font-sans">
          <span className="flex">
            <span className="flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: ASHA }}>
              A
            </span>
            <span className="-ml-1 flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-surface-2" style={{ background: RAVI }}>
              R
            </span>
          </span>
          2 here
        </span>
      }
    >
      <div className="pt-2">
        <Line n={1}>
          <K>def</K> is_prime(n):
        </Line>
        <Line n={2}>
          {"    "}
          <K>if</K> n {"<"} <N>2</N>:
          <Cursor name="Asha" color={ASHA} />
        </Line>
        <Line n={3}>
          {"        "}
          <K>return</K> <K>False</K>
        </Line>
        <Line n={4}>
          {"    "}
          <K>for</K> d <K>in</K> range(<N>2</N>, n):
        </Line>
        <Line n={5}>
          {"        "}
          <K>if</K> n % d == <N>0</N>
          <Cursor name="Ravi" color={RAVI} />
        </Line>
      </div>
      <Rule>Console · shared</Rule>
      <div className="px-3 pt-1 text-fg-subtle">Asha ran the program</div>
    </Frame>
  );
}

const DEMOS: Record<string, ReactNode> = {
  "online-compiler": <RunDemo />,
  "online-debugger": <DebugDemo />,
  "code-visualizer": <VisualDemo />,
  "online-compiler-with-test-cases": <TestsDemo />,
  "code-together": <TogetherDemo />,
};
