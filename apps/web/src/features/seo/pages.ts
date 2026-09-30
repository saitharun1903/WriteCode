/**
 * Public landing pages: one per thing people search for ("java online
 * compiler", "online debugger"…). Each is static HTML with real content and
 * opens the IDE ready for that language. Copy stays factual: it only claims
 * what the product does today.
 */

export const SITE = {
  url: "https://writecode.in",
  name: "WriteCode",
  tagline: "Online compiler, debugger and visualizer",
} as const;

export interface Faq {
  q: string;
  a: string;
}

export interface LandingPage {
  slug: string;
  /** <title>: what people type into the search box, then the brand. */
  title: string;
  description: string;
  h1: string;
  intro: string;
  /** Language the "Open" button starts a project in. */
  language: "java" | "python" | "c" | "cpp" | "javascript" | "typescript";
  cta: string;
  sample: { file: string; code: string };
  features: { title: string; text: string }[];
  steps: string[];
  faqs: Faq[];
  /** Short name in link lists. */
  label: string;
  kind: "language" | "feature";
}

const COMMON_FAQS: Faq[] = [
  { q: "Is it free?", a: "Yes. Running, debugging, tests and live sessions are free, with no sign-up." },
  {
    q: "Where are my projects saved?",
    a: "In your browser, on your device, automatically as you type. Nothing is lost when you close the tab. They stay until you delete them.",
  },
  {
    q: "Is my code safe to run?",
    a: "Every program runs in its own isolated sandbox with no internet access and strict limits on time, memory and processes, and is deleted when it finishes.",
  },
];

const JAVA = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        long sum = 0;
        for (int i = 1; i <= n; i++) sum += i;
        System.out.println("Sum of 1.." + n + " = " + sum);
    }
}`;

const PYTHON = `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

n = int(input("How many? "))
print([fib(i) for i in range(n)])`;

const C = `#include <stdio.h>

int main(void) {
    int n;
    scanf("%d", &n);
    int fact = 1;
    for (int i = 2; i <= n; i++) fact *= i;
    printf("%d! = %d\\n", n, fact);
    return 0;
}`;

const CPP = `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

int main() {
    int n; cin >> n;
    vector<int> v(n);
    for (auto &x : v) cin >> x;
    sort(v.begin(), v.end());
    for (int x : v) cout << x << ' ';
    cout << endl;
}`;

const JS = `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const words = line.trim().split(/\\s+/);
  console.log(words.reverse().join(" "));
  rl.close();
});`;

const TS = `interface Student {
  name: string;
  marks: number[];
}

const average = (s: Student) => s.marks.reduce((a, b) => a + b, 0) / s.marks.length;

const ravi: Student = { name: "Ravi", marks: [78, 91, 85] };
console.log(\`\${ravi.name}: \${average(ravi).toFixed(1)}\`);`;

const RUN_FEATURES = (lang: string, version: string) => [
  { title: `Real ${lang} ${version}`, text: `Your code is compiled and run by the real ${lang} toolchain on our servers, not a simulation, with the exact errors you would see on your own computer.` },
  { title: "Input while it runs", text: "Programs that read input (Scanner, input(), scanf, cin) ask for it in the console as they run, just like a terminal. Or prepare the input in advance." },
  { title: "Test cases", text: "Add inputs with the expected output and run them all with one click. See which lines differ, like on a coding judge, for any code you write." },
  { title: "Errors explained", text: "Compiler and runtime errors link to the exact line, with a plain-English explanation of what went wrong and how to fix it." },
  { title: "AI help that sees your code", text: "Ask why a test fails or what an error means. The assistant sees your files and the real output, and can fix the right line for you." },
  { title: "Code together live", text: "Share a link and code with friends or students in real time: shared cursors, edits, runs and test results." },
];

const DEBUG_FEATURES = [
  { title: "Step-by-step debugger", text: "Set breakpoints, step over, into and out, and watch variables and expressions change, right in the browser." },
  { title: "Visualizer", text: "Replay your program line by line and see arrays, objects and the call stack drawn as it runs. Ideal for learning recursion and data structures." },
];

const langPage = (p: {
  slug: string;
  language: LandingPage["language"];
  name: string;
  version: string;
  label: string;
  sample: LandingPage["sample"];
  debugs: boolean;
  intro: string;
  extraFaqs: Faq[];
}): LandingPage => ({
  slug: p.slug,
  kind: "language",
  label: p.label,
  language: p.language,
  title: `Online ${p.name} Compiler: run${p.debugs ? ", debug and visualize" : " and test"} ${p.name} code`,
  description: `Free online ${p.name} compiler (${p.version}). Write, run${p.debugs ? ", debug with breakpoints, visualize step by step" : ""} and test ${p.name} programs with input in your browser. No sign-up, no install.`,
  h1: `Online ${p.name} compiler`,
  intro: p.intro,
  cta: `Open the ${p.name} compiler`,
  sample: p.sample,
  features: [...RUN_FEATURES(p.name, p.version).slice(0, 2), ...(p.debugs ? DEBUG_FEATURES : []), ...RUN_FEATURES(p.name, p.version).slice(2)],
  steps: [
    `Click "Open the ${p.name} compiler". A project with a ready-to-run ${p.sample.file} opens.`,
    "Write your code. Files save automatically in your browser as you type.",
    `Press Run (Ctrl+Enter). If the program reads input, type it in the console${p.debugs ? ", or press Debug (F5) to step through it" : ""}.`,
    "Add test cases to check your program against expected outputs, or share a live link to code with someone.",
  ],
  faqs: [...p.extraFaqs, ...COMMON_FAQS],
});

export const LANDING_PAGES: LandingPage[] = [
  langPage({
    slug: "java-online-compiler",
    language: "java",
    name: "Java",
    version: "21",
    label: "Java compiler",
    sample: { file: "Main.java", code: JAVA },
    debugs: true,
    intro:
      "Write and run Java 21 in your browser with a real JDK. Read input with Scanner, split code into several classes and files, debug with breakpoints and watch your program run step by step. Useful for college lab programs, practice and interviews.",
    extraFaqs: [
      { q: "Which Java version is used?", a: "Java 21 (Eclipse Temurin), the current long-term support release." },
      { q: "Can I use Scanner to read input?", a: "Yes. Type the input in the console while the program runs, or prepare it in Program Input before you press Run." },
      { q: "Can my project have several classes?", a: "Yes. Add as many .java files and folders (packages) as you need; the class with main() is found automatically." },
    ],
  }),
  langPage({
    slug: "python-online-compiler",
    language: "python",
    name: "Python",
    version: "3.13",
    label: "Python compiler",
    sample: { file: "main.py", code: PYTHON },
    debugs: true,
    intro:
      "Run Python 3.13 online with input(), several files and modules, a real debugger and a step-by-step visualizer that draws your lists, dictionaries and objects. Made for learning, practice and quick experiments.",
    extraFaqs: [
      { q: "Which Python version is used?", a: "Python 3.13." },
      { q: "Does input() work?", a: "Yes. The console asks for the value while the program runs, like a terminal." },
      { q: "Can I import my own modules?", a: "Yes. Create more .py files in the project and import them as usual." },
    ],
  }),
  langPage({
    slug: "c-online-compiler",
    language: "c",
    name: "C",
    version: "(GCC 14, C17)",
    label: "C compiler",
    sample: { file: "main.c", code: C },
    debugs: false,
    intro:
      "Compile and run C programs online with GCC 14 (C17). Read input with scanf, see compiler errors on the exact line with an explanation, and check your program with test cases. Ideal for C programming labs.",
    extraFaqs: [
      { q: "Which compiler is used?", a: "GCC 14 in C17 mode. Errors point to the exact line in your code." },
      { q: "Does scanf work?", a: "Yes. Type input in the console while the program runs, or prepare it before running." },
    ],
  }),
  langPage({
    slug: "cpp-online-compiler",
    language: "cpp",
    name: "C++",
    version: "(GCC 14, C++20)",
    label: "C++ compiler",
    sample: { file: "main.cpp", code: CPP },
    debugs: false,
    intro:
      "Write and run C++20 online with GCC 14 and the full standard library (vector, map, algorithm…). Read input with cin, test against expected outputs like a coding judge, and get errors explained in plain English.",
    extraFaqs: [
      { q: "Which C++ standard is supported?", a: "C++20 with GCC 14, including the whole standard library." },
      { q: "Can I practise competitive programming?", a: "Yes. Add test cases with input and expected output and run them all at once; differences are highlighted line by line." },
    ],
  }),
  langPage({
    slug: "javascript-online-compiler",
    language: "javascript",
    name: "JavaScript",
    version: "(Node.js 22)",
    label: "JavaScript runner",
    sample: { file: "main.js", code: JS },
    debugs: false,
    intro: "Run JavaScript online on Node.js 22. Read input from the console, split code into modules, and test your functions against expected outputs.",
    extraFaqs: [{ q: "Is this browser JavaScript or Node.js?", a: "Node.js 22, so require, modules and process.stdin work as they do on your computer." }],
  }),
  langPage({
    slug: "typescript-online-compiler",
    language: "typescript",
    name: "TypeScript",
    version: "(Node.js 22)",
    label: "TypeScript runner",
    sample: { file: "main.ts", code: TS },
    debugs: false,
    intro: "Run TypeScript online without any setup: write .ts files and run them directly on Node.js 22, with input, several files and test cases.",
    extraFaqs: [{ q: "Do I need to compile it first?", a: "No. Press Run and the TypeScript runs directly; types are stripped automatically." }],
  }),
  {
    slug: "online-compiler",
    kind: "feature",
    label: "Online compiler",
    language: "java",
    title: "Online Compiler & IDE for Java, Python, C, C++ and JavaScript",
    description:
      "Free online compiler and IDE: run Java, Python, C, C++, JavaScript and TypeScript in your browser, with input, a debugger, a visualizer, test cases and AI help. No sign-up.",
    h1: "Online compiler and IDE",
    intro:
      "WriteCode is a full coding environment in your browser: projects with many files, real compilers for six languages, a debugger, a step-by-step visualizer, test cases and live collaboration. Open it and start coding in seconds.",
    cta: "Open the editor",
    sample: { file: "Main.java", code: JAVA },
    features: [
      { title: "Six languages", text: "Java 21, Python 3.13, C and C++ (GCC 14), JavaScript and TypeScript (Node.js 22), all running on real toolchains." },
      ...DEBUG_FEATURES,
      ...RUN_FEATURES("", "").slice(1),
    ],
    steps: ["Choose a language on the start screen.", "Write your code; it saves automatically.", "Press Run, debug, or add test cases.", "Share a live link to code together."],
    faqs: [{ q: "Which languages are supported?", a: "Java, Python, C, C++, JavaScript and TypeScript." }, ...COMMON_FAQS],
  },
  {
    slug: "online-debugger",
    kind: "feature",
    label: "Online debugger",
    language: "java",
    title: "Online Debugger for Java and Python: breakpoints, step, watch",
    description:
      "Debug Java and Python online: set breakpoints, step over, into and out, inspect variables and watch expressions in your browser. Free, no install.",
    h1: "Online debugger for Java and Python",
    intro:
      "Find bugs the way professionals do, without installing an IDE. Click in the margin to set a breakpoint, press Debug, and step through your program while its variables update next to the code.",
    cta: "Open the debugger",
    sample: { file: "Main.java", code: JAVA },
    features: [
      { title: "Breakpoints", text: "Click the margin or press F9. The program pauses on that line and the editor shows where you are." },
      { title: "Step over, into, out", text: "F10, F11 and Shift+F11 move one step at a time, into functions and back out." },
      { title: "Variables and watches", text: "See every local variable, expand arrays, lists and objects, and add watch expressions that update at each step." },
      { title: "Values inline", text: "The current value of each variable appears right next to the line that uses it." },
      { title: "Input while debugging", text: "Programs that read input pause for it, so you can debug interactive programs too." },
      { title: "Uncaught exceptions", text: "The debugger stops where an exception is thrown, with the explanation of what went wrong." },
    ],
    steps: ["Open the debugger and write or paste your program.", "Click in the margin next to a line to add a breakpoint.", "Press Debug (F5).", "Step with F10 / F11 and watch the variables change."],
    faqs: [
      { q: "Which languages can I debug?", a: "Java and Python. C, C++, JavaScript and TypeScript can be run and tested." },
      ...COMMON_FAQS,
    ],
  },
  {
    slug: "code-visualizer",
    kind: "feature",
    label: "Code visualizer",
    language: "python",
    title: "Data Structure Visualizer: stacks, queues, linked lists, trees, graphs",
    description:
      "Visualize your own Java and Python code step by step: stacks, queues, linked lists, binary trees, BSTs, heaps, tries, hash maps, graphs with BFS and DFS, 2D DP tables and two pointers.",
    h1: "Code visualizer",
    intro:
      "Press Visualize and your program is recorded as it runs. Each data structure is drawn the way it is taught: a stack as a pile with a top, a queue with a front and a rear, a linked list as a chain of nodes, a tree as a tree and a graph as nodes and edges. Step forward and back and watch every push, pop, insert and visit.",
    cta: "Open the visualizer",
    sample: { file: "main.py", code: PYTHON },
    features: [
      { title: "Stacks and queues", text: "Push and pop on a stack with its top marked; enqueue and dequeue with the front and rear marked. Deques and priority queues too." },
      { title: "Linked lists", text: "Singly, doubly and circular lists as chains of nodes, with head, curr, prev, slow and fast shown where they point." },
      { title: "Trees", text: "Binary trees, binary search trees, AVL and red-black trees, N-ary trees, tries, heaps and segment trees, laid out as trees." },
      { title: "Graphs", text: "Adjacency lists, matrices and edge lists become nodes and edges, with visited nodes, the queue or stack, the current node and distances during BFS and DFS." },
      { title: "Hash maps and sets", text: "Dictionaries and HashMaps as key and value tables; sets as a group of values." },
      { title: "Arrays and DP tables", text: "Index variables like i, j, left, right and mid shown under the array; 2D tables with the current cell highlighted." },
      { title: "Every step recorded", text: "Move forward and back through the whole run, or jump to any step with the slider." },
      { title: "Memory view", text: "Switch to the memory view to see every object and reference as boxes and arrows." },
      { title: "Call stack", text: "See each function call and its local variables, which makes recursion easy to follow." },
      { title: "Line by line", text: "The editor highlights the line that just ran and the one that runs next." },
      { title: "Ask AI about a step", text: "Not sure why a value changed? Ask the assistant about the step you are looking at." },
    ],
    steps: ["Open the visualizer and write a short program.", "Press Visualize.", "Use the arrows or slider to move through the steps."],
    faqs: [
      { q: "Which languages can be visualized?", a: "Java and Python." },
      {
        q: "Which data structures are drawn?",
        a: "Arrays and strings with index pointers, 2D arrays, stacks, queues, deques, priority queues and heaps, hash maps and sets, singly, doubly and circular linked lists, binary trees, binary search trees, AVL and red-black trees, N-ary and ternary trees, tries, segment trees, and graphs from adjacency lists, adjacency matrices, edge lists or node objects.",
      },
      {
        q: "Do I have to change my code?",
        a: "No. Structures are recognised from the program as it runs: Java collections like ArrayDeque, PriorityQueue and HashMap, Python lists, deques, dicts and sets, and your own node classes with fields such as next, left and right, or children.",
      },
      ...COMMON_FAQS,
    ],
  },
  {
    slug: "online-compiler-with-test-cases",
    kind: "feature",
    label: "Test cases",
    language: "cpp",
    title: "Run Your Code Against Test Cases Online",
    description:
      "Check any program against test cases online: give inputs and expected outputs, run them all at once and see exactly which line differs. Java, Python, C, C++, JavaScript.",
    h1: "Test your code with test cases",
    intro:
      "Like a coding judge, but for your own code. Add inputs with the output you expect, press Run all, and see which tests pass, which fail and the first line that differs.",
    cta: "Open with test cases",
    sample: { file: "main.cpp", code: CPP },
    features: [
      { title: "Any program", text: "Tests work with the code you write, not only with prepared problems." },
      { title: "Line-by-line differences", text: "A failing test shows your output and the expected output side by side, with the first difference marked." },
      { title: "Fixed values detected", text: "If your code ignores the input (hard-coded values), you are told and can switch it to read input in one click." },
      { title: "Run from your last run", text: "Turn the input and output of a run into a test with one click." },
      { title: "Shared in live sessions", text: "When you code together, tests and their results are shared too." },
    ],
    steps: ["Open the editor and write your program.", "Open Tests and add inputs with expected outputs.", "Press Run all and fix what fails."],
    faqs: [{ q: "Are trailing spaces compared?", a: "No. Trailing spaces and blank lines at the end are ignored, like most judges." }, ...COMMON_FAQS],
  },
  {
    slug: "code-together",
    kind: "feature",
    label: "Code together live",
    language: "python",
    title: "Code Together Online: live collaborative code editor",
    description:
      "Code together in real time: share a link, edit the same files, see each other's cursors, run and debug together. For tutoring, pair programming and classes. Free.",
    h1: "Code together, live",
    intro:
      "Share a link and write code with someone else at the same time, like a shared document for programs. Everyone sees the edits, cursors, runs, test results and the debugger's position as they happen.",
    cta: "Start coding together",
    sample: { file: "main.py", code: PYTHON },
    features: [
      { title: "Real-time editing", text: "Type in the same file at once without overwriting each other." },
      { title: "Cursors with names", text: "Each person's cursor and selection shows in their colour, with their name." },
      { title: "Shared runs and input", text: "When someone runs the program everyone sees the output, and anyone who can edit may type its input." },
      { title: "Follow and present", text: "Follow someone to see what they see. View-only guests follow the presenter automatically." },
      { title: "Roles", text: "Choose who can edit and who can only watch; remove people; end the session for everyone." },
      { title: "Invite by link or email", text: "Copy the link, send it on WhatsApp, or email it from your own email app." },
    ],
    steps: ["Open a project and click Share.", "Enter your name and start a live session.", "Send the link. People join by typing their name."],
    faqs: [
      { q: "Do the others need an account?", a: "No. Whoever has the link joins by typing a name. You can make them view-only or remove them." },
      { q: "How many people can join?", a: "Up to 100 people in one session, for example a whole class watching the teacher." },
      ...COMMON_FAQS,
    ],
  },
];

export const pageBySlug = (slug: string) => LANDING_PAGES.find((p) => p.slug === slug);
