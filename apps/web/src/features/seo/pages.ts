import { LANGUAGES } from "@cw/shared";

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

/** Names joined as a sentence reads them: "A, B and C". */
function sentence(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** The languages with the debugger and the visualizer, from the registry, so the copy follows what is shipped. */
const DEBUGGABLE = sentence(LANGUAGES.filter((l) => l.debugger && l.visualizer).map((l) => l.name));

export interface LandingPage {
  slug: string;
  /** <title>: what people type into the search box, then the brand. */
  title: string;
  description: string;
  h1: string;
  intro: string;
  /** Language the "Open" button starts a project in. */
  language: "java" | "python" | "c" | "cpp" | "javascript" | "typescript" | "kotlin" | "go" | "rust" | "csharp" | "php" | "ruby" | "sql" | "html";
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

const KOTLIN = `data class Student(val name: String, val marks: Int)

fun main() {
    val n = readln().toInt()
    val students = List(n) {
        val (name, marks) = readln().split(" ")
        Student(name, marks.toInt())
    }
    val best = students.maxByOrNull { it.marks }
    println("Top: \${best?.name}")
}`;

const GO = `package main

import "fmt"

func main() {
	var n int
	fmt.Scan(&n)
	sum := 0
	for i := 1; i <= n; i++ {
		sum += i
	}
	fmt.Println("Sum of 1..", n, "=", sum)
}`;

const RUST = `use std::io;

fn main() {
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap();
    let n: u64 = line.trim().parse().unwrap();
    let squares: Vec<u64> = (1..=n).map(|x| x * x).collect();
    println!("{:?}", squares);
}`;

const CSHARP = `using System;
using System.Linq;

class Program
{
    static void Main()
    {
        int[] marks = Console.ReadLine().Split(' ').Select(int.Parse).ToArray();
        Console.WriteLine($"Average: {marks.Average():F1}");
    }
}`;

const PHP = `<?php

$words = explode(" ", trim(fgets(STDIN)));
$counts = array_count_values($words);
arsort($counts);

foreach ($counts as $word => $count) {
    echo "$word: $count\n";
}`;

const RUBY = `names = gets.split

names.sort.each_with_index do |name, i|
  puts "#{i + 1}. #{name.capitalize}"
end`;

const SQL = `CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  marks INTEGER
);

INSERT INTO students (name, marks) VALUES
  ('Asha', 91), ('Ravi', 78), ('Meera', 85);

SELECT name, marks
FROM students
WHERE marks > 80
ORDER BY marks DESC;`;

const HTML = `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Hello World</h1>
    <button id="button">Click me</button>
    <script src="script.js"></script>
  </body>
</html>`;

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
  /** Visualized step by step (defaults to `debugs`). */
  visualizes?: boolean;
  intro: string;
  extraFaqs: Faq[];
}): LandingPage => ({
  slug: p.slug,
  kind: "language",
  label: p.label,
  language: p.language,
  title: `Online ${p.name} Compiler: run${p.debugs ? ", debug and visualize" : (p.visualizes ?? p.debugs) ? ", visualize and test" : " and test"} ${p.name} code`,
  description: `Free online ${p.name} compiler (${p.version}). Write, run${p.debugs ? ", debug with breakpoints, visualize step by step" : (p.visualizes ?? p.debugs) ? ", visualize step by step (stacks, queues, linked lists, trees, graphs)" : ""} and test ${p.name} programs with input in your browser. No sign-up, no install.`,
  h1: `Online ${p.name} compiler`,
  intro: p.intro,
  cta: `Open the ${p.name} compiler`,
  sample: p.sample,
  features: [
    ...RUN_FEATURES(p.name, p.version).slice(0, 2),
    ...(p.debugs ? DEBUG_FEATURES : (p.visualizes ?? p.debugs) ? DEBUG_FEATURES.slice(1) : []),
    ...RUN_FEATURES(p.name, p.version).slice(2),
  ],
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
    debugs: true,
    intro:
      "Compile and run C programs online with GCC 14 (C17). Read input with scanf, see compiler errors on the exact line with an explanation, debug with breakpoints, watch pointers, arrays and structs change in the visualizer, and check your program with test cases. Ideal for C programming labs.",
    extraFaqs: [
      { q: "Which compiler is used?", a: "GCC 14 in C17 mode. Errors point to the exact line in your code." },
      { q: "Does scanf work?", a: "Yes. Type input in the console while the program runs, or prepare it before running." },
      { q: "Can I debug C online?", a: "Yes. Set breakpoints, step through your code and see variables, arrays, structs and pointers; a segmentation fault stops on the line that caused it." },
    ],
  }),
  langPage({
    slug: "cpp-online-compiler",
    language: "cpp",
    name: "C++",
    version: "(GCC 14, C++20)",
    label: "C++ compiler",
    sample: { file: "main.cpp", code: CPP },
    debugs: true,
    intro:
      "Write and run C++20 online with GCC 14 and the full standard library (vector, map, algorithm…). Read input with cin, debug with breakpoints and see vectors and maps as values, visualize stacks, queues, trees and graphs step by step, test against expected outputs like a coding judge, and get errors explained in plain English.",
    extraFaqs: [
      { q: "Which C++ standard is supported?", a: "C++20 with GCC 14, including the whole standard library." },
      { q: "Can I practise competitive programming?", a: "Yes. Add test cases with input and expected output and run them all at once; differences are highlighted line by line." },
      { q: "Can I debug C++ online?", a: "Yes. Breakpoints, stepping and variables work with the standard library: vector, map, string and the rest show their contents." },
    ],
  }),
  langPage({
    slug: "javascript-online-compiler",
    language: "javascript",
    name: "JavaScript",
    version: "(Node.js 22)",
    label: "JavaScript runner",
    sample: { file: "main.js", code: JS },
    debugs: true,
    intro: "Run JavaScript online on Node.js 22. Read input from the console, split code into modules, debug with breakpoints, test your functions against expected outputs, and watch arrays, objects, linked lists, trees and graphs change step by step in the visualizer.",
    extraFaqs: [{ q: "Is this browser JavaScript or Node.js?", a: "Node.js 22, so require, modules and process.stdin work as they do on your computer." }],
  }),
  langPage({
    slug: "typescript-online-compiler",
    language: "typescript",
    name: "TypeScript",
    version: "(Node.js 22)",
    label: "TypeScript runner",
    sample: { file: "main.ts", code: TS },
    debugs: true,
    intro: "Run TypeScript online without any setup: write .ts files and run them directly on Node.js 22, with input, several files, a debugger that stops on the exact TypeScript line, test cases and a step-by-step visualizer that draws your data structures.",
    extraFaqs: [{ q: "Do I need to compile it first?", a: "No. Press Run and the TypeScript runs directly; types are stripped automatically." }],
  }),
  langPage({
    slug: "kotlin-online-compiler",
    language: "kotlin",
    name: "Kotlin",
    version: "2.2",
    label: "Kotlin compiler",
    sample: { file: "Main.kt", code: KOTLIN },
    debugs: true,
    intro: "Write and run Kotlin 2.2 in your browser on a real JVM. Read input with readln(), use data classes and collections, debug with breakpoints and watch the program run step by step in the visualizer. Nothing to install.",
    extraFaqs: [
      { q: "Which Kotlin version is used?", a: "Kotlin 2.2, compiled for the JVM (Java 21)." },
      { q: "Can I debug Kotlin online?", a: "Yes. Set breakpoints, step through the code and see variables and objects; the visualizer draws lists, maps and linked structures as the program runs." },
      { q: "Can my project have several files?", a: "Yes. Every .kt file of the project is compiled with the file you run." },
    ],
  }),
  langPage({
    slug: "go-online-compiler",
    language: "go",
    name: "Go",
    version: "1.25",
    label: "Go compiler",
    sample: { file: "main.go", code: GO },
    debugs: false,
    intro: "Write and run Go 1.25 in your browser with the real Go compiler. Read input with fmt.Scan or bufio, split a program over several files, check it against test cases and share it with a link. Nothing to install.",
    extraFaqs: [
      { q: "Which Go version is used?", a: "Go 1.25, with the whole standard library." },
      { q: "Can I use several files?", a: "Yes. Every .go file of the project that belongs to package main is built into the program." },
      { q: "Can I use packages from the internet?", a: "No. Programs run with no internet access, so they use the standard library." },
    ],
  }),
  langPage({
    slug: "rust-online-compiler",
    language: "rust",
    name: "Rust",
    version: "1.90",
    label: "Rust compiler",
    sample: { file: "main.rs", code: RUST },
    debugs: true,
    intro: "Compile and run Rust 1.90 online with rustc (2021 edition). The compiler's errors link to the exact line and column, a panic stops in the debugger where it happened, and you can step through the program with breakpoints or watch it run in the visualizer: Vec, HashMap, structs and Option<Box<..>> lists drawn as they change.",
    extraFaqs: [
      { q: "Which Rust version and edition?", a: "Rust 1.90, 2021 edition, with the standard library." },
      { q: "Can I split code into modules?", a: "Yes. Add a file such as util.rs and declare it with `mod util;` in main.rs." },
      { q: "Can I use crates?", a: "No. Programs run with no internet access, so only the standard library is available." },
    ],
  }),
  langPage({
    slug: "csharp-online-compiler",
    language: "csharp",
    name: "C#",
    version: "(.NET 8, C# 12)",
    label: "C# compiler",
    sample: { file: "Program.cs", code: CSHARP },
    debugs: false,
    intro: "Write and run C# 12 on .NET 8 in your browser. Classes with a Main method and top-level statements both work, with LINQ, generics, async and the rest of the base class library. Console.ReadLine reads from the console as the program runs.",
    extraFaqs: [
      { q: "Which C# and .NET version?", a: "C# 12 on .NET 8." },
      { q: "Do top-level statements work?", a: "Yes. A file can start with statements directly; the usual namespaces (System, System.Linq, System.Collections.Generic) are already imported." },
      { q: "Can my project have several classes and files?", a: "Yes. Every .cs file of the project is compiled into the program." },
    ],
  }),
  langPage({
    slug: "php-online-compiler",
    language: "php",
    name: "PHP",
    version: "8.4",
    label: "PHP runner",
    sample: { file: "main.php", code: PHP },
    debugs: false,
    intro: "Run PHP 8.4 scripts online from the command line: read input from STDIN, include other files of the project, and see parse errors and exceptions with the line they are on.",
    extraFaqs: [
      { q: "Which PHP version is used?", a: "PHP 8.4, run as a command-line script." },
      { q: "Can I include other files?", a: "Yes. Add more .php files to the project and use require or include." },
      { q: "Does it run a web server or a database?", a: "No. The script runs once and prints its output, like `php main.php` in a terminal." },
    ],
  }),
  langPage({
    slug: "ruby-online-compiler",
    language: "ruby",
    name: "Ruby",
    version: "3.4",
    label: "Ruby runner",
    sample: { file: "main.rb", code: RUBY },
    debugs: true,
    intro: "Run Ruby 3.4 online. Read input with gets, split a program over several files with require_relative, debug it with breakpoints, and watch it run step by step in the visualizer: arrays, hashes, objects and linked nodes drawn as they change.",
    extraFaqs: [
      { q: "Which Ruby version is used?", a: "Ruby 3.4." },
      { q: "Does gets work?", a: "Yes. The console asks for the input while the program runs, like a terminal." },
      { q: "Can I install gems?", a: "No. Programs run with no internet access, so they use Ruby's standard library." },
    ],
  }),
  {
    slug: "sql-online-compiler",
    kind: "language",
    label: "SQL editor",
    language: "sql",
    title: "Online SQL Editor: run SQL queries in your browser",
    description: "Free online SQL editor and compiler. Create tables, insert rows and run SELECT queries on a real SQLite database in your browser. Results are shown as tables. No sign-up, no install.",
    h1: "Online SQL editor",
    intro: "Write SQL and run it on a real SQLite database that belongs to your project, laid out like a database tool: the tables and their columns on the left, your queries in the middle, the rows of each query in a grid below. The database keeps its tables and rows between runs, and an error names the line of the statement that caused it.",
    cta: "Open the SQL editor",
    sample: { file: "main.sql", code: SQL },
    features: [
      { title: "A real database", text: "Queries run on SQLite 3, not a simulation: joins, GROUP BY, subqueries, views, indexes, foreign keys and transactions all work." },
      { title: "A grid for every query", text: "Each query's rows open in a tab of their own, with column names, row numbers and a row count; copy them or save them as CSV. The Output tab lists what every statement did (3 rows inserted, 1 row updated) and how long it took." },
      { title: "The database stays", text: "Tables and rows are kept from one run to the next, so one file can create the tables and another can query them. The panel on the left shows every table with its columns, keys and row count; emptying the database is one press." },
      { title: "Run one statement", text: "Select a statement and press Run to run just that one, as in MySQL Workbench or DBeaver. With nothing selected, the whole file runs." },
      { title: "MySQL-style SQL accepted", text: "AUTO_INCREMENT, ENGINE=..., ENUM, CREATE DATABASE and USE, SHOW TABLES, DESCRIBE, and functions like NOW(), CONCAT(), IF() and YEAR() work as they are written for MySQL." },
      { title: "Errors on their line", text: "A mistake stops the run and names the line where its statement starts; click it to go there." },
      { title: "Several files", text: "Keep the schema in one file and the queries in another; Run runs the file that is open, on the same database." },
      { title: "Share and work together", text: "Send a link to your queries, or edit them live with someone else." },
    ],
    steps: ["Open the SQL editor: a sample table and query are ready.", "Write your CREATE TABLE, INSERT and SELECT statements.", "Press Run: each query's rows open in a grid, and the tables you made appear in the database panel."],
    faqs: [
      { q: "Which database is it?", a: "SQLite 3. Standard SQL works, and the usual MySQL forms are accepted too: AUTO_INCREMENT, SHOW TABLES, DESCRIBE, CREATE DATABASE and USE, and functions such as NOW() and CONCAT()." },
      { q: "Is my data kept between runs?", a: "Yes. The project has one database, saved in your browser with the project, and every run works on it. To start again from nothing, empty it from the database panel, or begin your script with DROP TABLE IF EXISTS." },
      { q: "Why does it say the table already exists?", a: "The table was made by an earlier run and is still in the database. Put DROP TABLE IF EXISTS before CREATE TABLE, or empty the database." },
      ...COMMON_FAQS,
    ],
  },
  {
    slug: "html-css-online-editor",
    kind: "language",
    label: "HTML and CSS editor",
    language: "html",
    title: "Online HTML, CSS and JavaScript Editor with live preview",
    description: "Free online HTML, CSS and JavaScript editor. Write a page with its stylesheet and script and see it in a live preview that updates as you type, with a console for errors. No sign-up.",
    h1: "Online HTML, CSS and JavaScript editor",
    intro: "Write a web page in your browser and see it next to the code. The preview updates as you type, style.css and script.js are separate files as in a real site, and what the page logs or gets wrong shows in a console under it.",
    cta: "Open the HTML editor",
    sample: { file: "index.html", code: HTML },
    features: [
      { title: "Live preview", text: "The page is shown beside the code and follows it as you type. Run loads it afresh." },
      { title: "Separate files", text: "index.html, style.css and script.js, linked the usual way with <link> and <script>. Add more pages and link between them." },
      { title: "Console", text: "console.log output and JavaScript errors appear under the page, with errors in red." },
      { title: "Libraries from a CDN", text: "A page can load Bootstrap, a font or any other file by its web address." },
      { title: "Share and work together", text: "Send a link to the code, download it, or edit it live with someone else." },
    ],
    steps: ["Open the HTML editor: a page with a stylesheet and a script is ready.", "Change the HTML, the CSS or the JavaScript.", "Watch the preview update; press Run to load the page again."],
    faqs: [
      { q: "Does the page run on a server?", a: "No. It runs in your own browser, in a frame kept apart from the rest of the site." },
      { q: "Can I use more than one page?", a: "Yes. Add more .html files; a link from one to another opens it in the preview." },
      { q: "Does localStorage work?", a: "Yes, within a run: what the page stores is kept until the page is loaded again." },
      ...COMMON_FAQS,
    ],
  },
  {
    slug: "online-compiler",
    kind: "feature",
    label: "Online compiler",
    language: "java",
    title: "Online Compiler & IDE for Java, Python, C, C++, JavaScript and more",
    description:
      "Free online compiler and IDE: run Java, Python, C, C++, JavaScript, TypeScript, Kotlin, Go, Rust, C#, PHP, Ruby, SQL and Bash in your browser, and preview HTML and CSS live. With input, a debugger, a visualizer, test cases and AI help. No sign-up.",
    h1: "Online compiler and IDE",
    intro:
      "WriteCode is a full coding environment in your browser: projects with many files, real compilers for fourteen languages, a live preview for HTML and CSS, a debugger, a step-by-step visualizer, test cases and live collaboration. Open it and start coding in seconds.",
    cta: "Open the editor",
    sample: { file: "Main.java", code: JAVA },
    features: [
      { title: "Fifteen languages", text: "Java 21, Python 3.13, C and C++ (GCC 14), JavaScript and TypeScript (Node.js 22), Kotlin 2.2, Go 1.25, Rust 1.90, C# 12, PHP 8.4, Ruby 3.4, SQL (SQLite) and Bash, all running on real toolchains, and HTML with CSS in a live preview." },
      ...DEBUG_FEATURES,
      ...RUN_FEATURES("", "").slice(1),
    ],
    steps: ["Choose a language on the start screen.", "Write your code; it saves automatically.", "Press Run, debug, or add test cases.", "Share a live link to code together."],
    faqs: [
      { q: "Which languages are supported?", a: "Java, Python, C, C++, JavaScript, TypeScript, Kotlin, Go, Rust, C#, PHP, Ruby, SQL and Bash, and HTML with CSS and JavaScript in a live preview." },
      { q: "Which languages have the debugger and the visualizer?", a: `${DEBUGGABLE}. The other languages run, read input and can be checked with test cases.` },
      ...COMMON_FAQS,
    ],
  },
  {
    slug: "online-debugger",
    kind: "feature",
    label: "Online debugger",
    language: "java",
    title: "Online Debugger for Java, Python, C, C++, JavaScript and TypeScript",
    description:
      "Debug Java, Python, C, C++, JavaScript and TypeScript online: set breakpoints, step over, into and out, inspect variables and watch expressions in your browser. Free, no install.",
    h1: "Online debugger for every language",
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
      { q: "Which languages can I debug?", a: `${DEBUGGABLE}.` },
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
      "Visualize your own Java, Python, C, C++, JavaScript and TypeScript code step by step: stacks, queues, linked lists, binary trees, BSTs, heaps, tries, hash maps, graphs with BFS and DFS, 2D DP tables and two pointers.",
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
      { q: "Which languages can be visualized?", a: "Java, Python, C, C++, JavaScript and TypeScript." },
      {
        q: "Which data structures are drawn?",
        a: "Arrays and strings with index pointers, 2D arrays, stacks, queues, deques, priority queues and heaps, hash maps and sets, singly, doubly and circular linked lists, binary trees, binary search trees, AVL and red-black trees, N-ary and ternary trees, tries, segment trees, and graphs from adjacency lists, adjacency matrices, edge lists or node objects.",
      },
      {
        q: "Do I have to change my code?",
        a: "No. Structures are recognised from the program as it runs: Java collections like ArrayDeque, PriorityQueue and HashMap, Python lists, deques, dicts and sets, JavaScript arrays, Maps, Sets and plain objects, and your own node classes or objects with fields such as next, left and right, or children.",
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

/**
 * What the home page says the product does, one card each. `title` is what
 * people search for; `head` and `text` say it the way one person tells another.
 * Each links to the page about it.
 */
export const HOME_FEATURES: { title: string; head: string; text: string; more: string; slug: string }[] = [
  {
    title: "Online compiler",
    head: "Type it, run it",
    text: "Pick one of fifteen languages and press Run. Your program is built by the real compiler (JDK 21, GCC 14, Python 3.13, Node.js 22, Go, Rust, .NET) and the output appears under the code. When it asks for input, you type it in the console, the way you would in a terminal.",
    more: "About the online compiler",
    slug: "online-compiler",
  },
  {
    title: "Online debugger",
    head: "Stop on any line",
    text: `Click beside a line number to put a breakpoint there, then press Debug. The program stops on that line and you move one step at a time while the variables update next to the code. It works the same way in ${DEBUGGABLE}.`,
    more: "About the online debugger",
    slug: "online-debugger",
  },
  {
    title: "Code visualizer",
    head: "See what the code is doing",
    text: "Arrays, linked lists, trees and the call stack are drawn while your program runs. Go forward or back one line at a time. Good for recursion, and for the bug you cannot find by reading.",
    more: "About the code visualizer",
    slug: "code-visualizer",
  },
  {
    title: "Test cases",
    head: "Check every case at once",
    text: "Write an input and the output you expect, as many as you need, and run them together. A test that fails shows the first line where your output is different.",
    more: "About test cases",
    slug: "online-compiler-with-test-cases",
  },
  {
    title: "Code together",
    head: "Two people, one file",
    text: "Send a link and you are both in the same files, each with a named cursor. Runs and test results are shared. There is an interview mode too, with hidden tests and a report at the end.",
    more: "About coding together",
    slug: "code-together",
  },
];

export const HOME_FAQS: Faq[] = [
  {
    q: "What is WriteCode?",
    a: "WriteCode (writecode.in) is a free online compiler and IDE that runs in the browser. You can write and run Java, Python, C, C++, JavaScript, TypeScript, Kotlin, Go, Rust, C#, PHP, Ruby, SQL and Bash, preview HTML and CSS live, debug and visualize programs, test them, and share them.",
  },
  { q: "Do I need to install anything or sign up?", a: "No. Open writecode.in, choose a language and start typing. There is no download and no account." },
  { q: "Can my program read input?", a: "Yes. Type the input in the console while the program runs, as in a terminal, or prepare it before running. Scanner, input(), scanf, cin and readline all work." },
  { q: "Can I use it on a phone?", a: "Yes. The editor, Run, the console and the tests work on phones and tablets." },
  ...COMMON_FAQS,
];

export const pageBySlug = (slug: string) => LANDING_PAGES.find((p) => p.slug === slug);
