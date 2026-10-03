
/**
 * Editor snippets under the names people already type in IntelliJ and VS Code
 * (`psvm`, `sout`, `fori`...). Bodies use Monaco's snippet syntax: `$1` and
 * `${1:name}` are the Tab stops, `$0` is where the cursor ends, and
 * `${TM_FILENAME_BASE}` is the file name without its extension.
 */
export interface Snippet {
  prefix: string;
  /** What it writes, shown next to the prefix in the suggestion list. */
  detail: string;
  body: string;
}

const JAVA: Snippet[] = [
  { prefix: "psvm", detail: "main method", body: "public static void main(String[] args) {\n\t$0\n}" },
  { prefix: "main", detail: "class with a main method", body: "public class ${TM_FILENAME_BASE} {\n\tpublic static void main(String[] args) {\n\t\t$0\n\t}\n}" },
  { prefix: "sout", detail: "System.out.println()", body: "System.out.println($0);" },
  { prefix: "souf", detail: "System.out.printf()", body: 'System.out.printf("${1:%d}%n", $2);$0' },
  { prefix: "serr", detail: "System.err.println()", body: "System.err.println($0);" },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forr", detail: "for (int i = n - 1; i >= 0; i--)", body: "for (int ${1:i} = ${2:n} - 1; ${1:i} >= 0; ${1:i}--) {\n\t$0\n}" },
  { prefix: "iter", detail: "for (T x : items)", body: "for (${1:int} ${2:x} : ${3:items}) {\n\t$0\n}" },
  { prefix: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
  { prefix: "ifelse", detail: "if / else", body: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}" },
  { prefix: "tryc", detail: "try / catch", body: "try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}" },
  { prefix: "sc", detail: "Scanner reading input", body: "Scanner ${1:in} = new Scanner(System.in);$0" },
  { prefix: "readint", detail: "read n, then n numbers", body: "int ${1:n} = ${2:in}.nextInt();\nint[] ${3:arr} = new int[${1:n}];\nfor (int i = 0; i < ${1:n}; i++) ${3:arr}[i] = ${2:in}.nextInt();$0" },
];

const PYTHON: Snippet[] = [
  { prefix: "main", detail: 'if __name__ == "__main__":', body: 'def main():\n\t$0\n\n\nif __name__ == "__main__":\n\tmain()' },
  { prefix: "fori", detail: "for i in range(n):", body: "for ${1:i} in range(${2:n}):\n\t$0" },
  { prefix: "fore", detail: "for x in items:", body: "for ${1:x} in ${2:items}:\n\t$0" },
  { prefix: "def", detail: "function", body: "def ${1:name}(${2}):\n\t$0" },
  { prefix: "class", detail: "class with __init__", body: "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t$0" },
  { prefix: "trye", detail: "try / except", body: "try:\n\t$1\nexcept ${2:Exception} as e:\n\t$0" },
  { prefix: "inint", detail: "n = int(input())", body: "${1:n} = int(input())$0" },
  { prefix: "inlist", detail: "numbers from one input line", body: "${1:nums} = list(map(int, input().split()))$0" },
];

const CPP: Snippet[] = [
  {
    prefix: "main",
    detail: "program with main()",
    body: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n\tios::sync_with_stdio(false);\n\tcin.tie(nullptr);\n\t$0\n\treturn 0;\n}",
  },
  { prefix: "cout", detail: "cout << ... << endl", body: 'cout << $1 << "\\n";$0' },
  { prefix: "cin", detail: "cin >> ...", body: "cin >> $1;$0" },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forr", detail: "for (int i = n - 1; i >= 0; i--)", body: "for (int ${1:i} = ${2:n} - 1; ${1:i} >= 0; ${1:i}--) {\n\t$0\n}" },
  { prefix: "fore", detail: "for (auto& x : items)", body: "for (auto& ${1:x} : ${2:items}) {\n\t$0\n}" },
  { prefix: "readvec", detail: "read n, then n numbers", body: "int ${1:n};\ncin >> ${1:n};\nvector<int> ${2:a}(${1:n});\nfor (auto& x : ${2:a}) cin >> x;$0" },
];

const C: Snippet[] = [
  { prefix: "main", detail: "program with main()", body: "#include <stdio.h>\n\nint main(void) {\n\t$0\n\treturn 0;\n}" },
  { prefix: "printf", detail: 'printf("...\\n")', body: 'printf("${1:%d}\\n", $2);$0' },
  { prefix: "scanf", detail: 'scanf("%d", &x)', body: 'scanf("${1:%d}", &${2:x});$0' },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
];

const JS: Snippet[] = [
  { prefix: "log", detail: "console.log()", body: "console.log($0);" },
  { prefix: "fori", detail: "for (let i = 0; i < n; i++)", body: "for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forof", detail: "for (const x of items)", body: "for (const ${1:x} of ${2:items}) {\n\t$0\n}" },
  { prefix: "fn", detail: "function", body: "function ${1:name}(${2}) {\n\t$0\n}" },
  {
    prefix: "readinput",
    detail: "all of stdin as numbers",
    body: 'const ${1:data} = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);$0',
  },
];

const TS: Snippet[] = [
  {
    prefix: "readinput",
    detail: "all of stdin as numbers",
    body: 'const ${1:data} = require("node:fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);$0',
  },
];

PYTHON.push(
  { prefix: "while", detail: "while loop", body: "while ${1:condition}:\n\t$0" },
  { prefix: "ifelse", detail: "if / else", body: "if ${1:condition}:\n\t$2\nelse:\n\t$0" },
  { prefix: "lc", detail: "[x for x in items]", body: "[${1:x} for ${1:x} in ${2:items}]$0" },
  { prefix: "dc", detail: "{k: v for k, v in pairs}", body: "{${1:k}: ${2:v} for ${1:k}, ${2:v} in ${3:pairs}}$0" },
  { prefix: "lambda", detail: "lambda x: ...", body: "lambda ${1:x}: $0" },
  { prefix: "withopen", detail: "with open(...) as f:", body: 'with open("${1:file.txt}") as ${2:f}:\n\t$0' },
  { prefix: "pf", detail: 'print(f"...")', body: 'print(f"${1:{x\\}}")$0' },
  { prefix: "readall", detail: "every number from stdin", body: "import sys\n\n${1:data} = list(map(int, sys.stdin.read().split()))$0" },
  { prefix: "dataclass", detail: "@dataclass class", body: "from dataclasses import dataclass\n\n\n@dataclass\nclass ${1:Name}:\n\t${2:field}: ${3:int}$0" },
);
JAVA.push(
  { prefix: "class", detail: "class", body: "class ${1:Name} {\n\t$0\n}" },
  { prefix: "sb", detail: "StringBuilder", body: "StringBuilder ${1:sb} = new StringBuilder();$0" },
  { prefix: "list", detail: "List<Integer> = new ArrayList<>()", body: "List<${1:Integer}> ${2:list} = new ArrayList<>();$0" },
  { prefix: "map", detail: "Map<K, V> = new HashMap<>()", body: "Map<${1:String}, ${2:Integer}> ${3:map} = new HashMap<>();$0" },
  { prefix: "br", detail: "BufferedReader for fast input", body: "BufferedReader ${1:br} = new BufferedReader(new InputStreamReader(System.in));$0" },
  { prefix: "switch", detail: "switch", body: "switch (${1:value}) {\n\tcase ${2:1} -> $3;\n\tdefault -> $0;\n}" },
);
C.push(
  { prefix: "include", detail: "#include <...>", body: "#include <${1:stdlib.h}>$0" },
  { prefix: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
  { prefix: "struct", detail: "struct", body: "struct ${1:Name} {\n\t${2:int value};\n};$0" },
  { prefix: "func", detail: "function", body: "${1:int} ${2:name}(${3:void}) {\n\t$0\n}" },
  { prefix: "readarr", detail: "read n, then n numbers", body: 'int ${1:n};\nscanf("%d", &${1:n});\nint ${2:a}[${1:n}];\nfor (int i = 0; i < ${1:n}; i++) scanf("%d", &${2:a}[i]);$0' },
);
CPP.push(
  { prefix: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
  { prefix: "class", detail: "class", body: "class ${1:Name} {\npublic:\n\t$0\n};" },
  { prefix: "struct", detail: "struct", body: "struct ${1:Name} {\n\t$0\n};" },
  { prefix: "getline", detail: "read a whole line", body: "string ${1:line};\ngetline(cin, ${1:line});$0" },
  { prefix: "sortv", detail: "sort(v.begin(), v.end())", body: "sort(${1:v}.begin(), ${1:v}.end());$0" },
);
JS.push(
  { prefix: "arrow", detail: "const f = (x) => {}", body: "const ${1:name} = (${2}) => {\n\t$0\n};" },
  { prefix: "class", detail: "class", body: "class ${1:Name} {\n\tconstructor(${2}) {\n\t\t$0\n\t}\n}" },
  { prefix: "trycatch", detail: "try / catch", body: "try {\n\t$1\n} catch (${2:error}) {\n\t$0\n}" },
  { prefix: "ifelse", detail: "if / else", body: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}" },
  { prefix: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
  { prefix: "map", detail: "items.map(x => ...)", body: "${1:items}.map((${2:x}) => $0)" },
  { prefix: "filter", detail: "items.filter(x => ...)", body: "${1:items}.filter((${2:x}) => $0)" },
  { prefix: "reduce", detail: "items.reduce((sum, x) => ..., 0)", body: "${1:items}.reduce((${2:sum}, ${3:x}) => ${2:sum} + ${3:x}, ${4:0})$0" },
  { prefix: "qs", detail: "document.querySelector()", body: 'document.querySelector("${1:selector}")$0' },
  { prefix: "ael", detail: "addEventListener()", body: '${1:element}.addEventListener("${2:click}", (${3:event}) => {\n\t$0\n});' },
  { prefix: "timeout", detail: "setTimeout()", body: "setTimeout(() => {\n\t$0\n}, ${1:1000});" },
  { prefix: "readlines", detail: "stdin as lines", body: 'const ${1:lines} = require("fs").readFileSync(0, "utf8").trim().split("\\n");$0' },
);
TS.unshift(...JS.filter((s) => s.prefix !== "readinput" && s.prefix !== "readlines"));

const KOTLIN: Snippet[] = [
  { prefix: "main", detail: "fun main()", body: "fun main() {\n\t$0\n}" },
  { prefix: "fun", detail: "function", body: "fun ${1:name}(${2}): ${3:Unit} {\n\t$0\n}" },
  { prefix: "fori", detail: "for (i in 0 until n)", body: "for (${1:i} in 0 until ${2:n}) {\n\t$0\n}" },
  { prefix: "fore", detail: "for (x in items)", body: "for (${1:x} in ${2:items}) {\n\t$0\n}" },
  { prefix: "when", detail: "when", body: "when (${1:value}) {\n\t${2:1} -> $3\n\telse -> $0\n}" },
  { prefix: "dataclass", detail: "data class", body: "data class ${1:Name}(val ${2:value}: ${3:Int})$0" },
  { prefix: "readint", detail: "read a number", body: "val ${1:n} = readln().trim().toInt()$0" },
  { prefix: "readnums", detail: "numbers from one line", body: 'val ${1:nums} = readln().trim().split(" ").map { it.toInt() }$0' },
  { prefix: "ifelse", detail: "if / else", body: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}" },
];

const GO: Snippet[] = [
  { prefix: "main", detail: "package main with func main()", body: 'package main\n\nimport "fmt"\n\nfunc main() {\n\t$0\n}' },
  { prefix: "fori", detail: "for i := 0; i < n; i++", body: "for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t$0\n}" },
  { prefix: "forr", detail: "for i, v := range items", body: "for ${1:i}, ${2:v} := range ${3:items} {\n\t$0\n}" },
  { prefix: "func", detail: "function", body: "func ${1:name}(${2}) ${3:int} {\n\t$0\n}" },
  { prefix: "iferr", detail: "if err != nil", body: "if err != nil {\n\t${1:return err}\n}$0" },
  { prefix: "struct", detail: "type struct", body: "type ${1:Name} struct {\n\t${2:Value} ${3:int}\n}$0" },
  { prefix: "pl", detail: "fmt.Println()", body: "fmt.Println($0)" },
  { prefix: "pf", detail: "fmt.Printf()", body: 'fmt.Printf("${1:%v}\\n", $2)$0' },
  { prefix: "readint", detail: "var n int; fmt.Scan(&n)", body: "var ${1:n} int\nfmt.Scan(&${1:n})$0" },
  { prefix: "scanner", detail: "read lines with bufio.Scanner", body: "scanner := bufio.NewScanner(os.Stdin)\nfor scanner.Scan() {\n\t${1:line} := scanner.Text()\n\t$0\n}" },
  { prefix: "mapmake", detail: "make(map[K]V)", body: "${1:m} := make(map[${2:string}]${3:int})$0" },
];

const RUST: Snippet[] = [
  { prefix: "main", detail: "fn main()", body: "fn main() {\n\t$0\n}" },
  { prefix: "fn", detail: "function", body: "fn ${1:name}(${2}) -> ${3:i32} {\n\t$0\n}" },
  { prefix: "fori", detail: "for i in 0..n", body: "for ${1:i} in 0..${2:n} {\n\t$0\n}" },
  { prefix: "fore", detail: "for x in &items", body: "for ${1:x} in &${2:items} {\n\t$0\n}" },
  { prefix: "pl", detail: 'println!("{}", x)', body: 'println!("{\\}", $1);$0' },
  { prefix: "readline", detail: "read one line from stdin", body: "let mut ${1:line} = String::new();\nstd::io::stdin().read_line(&mut ${1:line}).unwrap();$0" },
  { prefix: "readnums", detail: "numbers from one line", body: "let ${1:nums}: Vec<i64> = ${2:line}.split_whitespace().map(|x| x.parse().unwrap()).collect();$0" },
  { prefix: "struct", detail: "struct", body: "struct ${1:Name} {\n\t${2:value}: ${3:i32},\n}$0" },
  { prefix: "impl", detail: "impl block", body: "impl ${1:Name} {\n\t$0\n}" },
  { prefix: "match", detail: "match", body: "match ${1:value} {\n\t${2:Some(x)} => $3,\n\t_ => $0,\n}" },
  { prefix: "iflet", detail: "if let Some(x) = ...", body: "if let Some(${1:x}) = ${2:value} {\n\t$0\n}" },
];

const CSHARP: Snippet[] = [
  { prefix: "cw", detail: "Console.WriteLine()", body: "Console.WriteLine($0);" },
  { prefix: "main", detail: "class with Main", body: "class Program\n{\n\tstatic void Main()\n\t{\n\t\t$0\n\t}\n}" },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)\n{\n\t$0\n}" },
  { prefix: "foreach", detail: "foreach (var x in items)", body: "foreach (var ${1:x} in ${2:items})\n{\n\t$0\n}" },
  { prefix: "prop", detail: "property", body: "public ${1:int} ${2:Name} { get; set; }$0" },
  { prefix: "class", detail: "class", body: "class ${1:Name}\n{\n\t$0\n}" },
  { prefix: "readint", detail: "int.Parse(Console.ReadLine())", body: "int ${1:n} = int.Parse(Console.ReadLine()!);$0" },
  { prefix: "readnums", detail: "numbers from one line", body: "var ${1:nums} = Console.ReadLine()!.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(int.Parse).ToArray();$0" },
  { prefix: "trycatch", detail: "try / catch", body: "try\n{\n\t$1\n}\ncatch (${2:Exception} e)\n{\n\t$0\n}" },
];

// In a snippet a literal $ is written \$, so PHP's variables and Bash's expansions are escaped.
const PHP: Snippet[] = [
  { prefix: "php", detail: "<?php", body: "<?php\n\n$0" },
  { prefix: "echo", detail: "echo ... PHP_EOL", body: "echo $1 . PHP_EOL;$0" },
  { prefix: "fori", detail: "for ($i = 0; $i < $n; $i++)", body: "for (\\$${1:i} = 0; \\$${1:i} < \\$${2:n}; \\$${1:i}++) {\n\t$0\n}" },
  { prefix: "foreach", detail: "foreach ($items as $x)", body: "foreach (\\$${1:items} as \\$${2:x}) {\n\t$0\n}" },
  { prefix: "function", detail: "function", body: "function ${1:name}(${2}) {\n\t$0\n}" },
  { prefix: "class", detail: "class", body: "class ${1:Name}\n{\n\tpublic function __construct(${2})\n\t{\n\t\t$0\n\t}\n}" },
  { prefix: "readline", detail: "read a line from input", body: "\\$${1:line} = trim(fgets(STDIN));$0" },
  { prefix: "readnums", detail: "numbers from one line", body: "\\$${1:nums} = array_map('intval', explode(' ', trim(fgets(STDIN))));$0" },
];

const RUBY: Snippet[] = [
  { prefix: "def", detail: "method", body: "def ${1:name}(${2})\n\t$0\nend" },
  { prefix: "class", detail: "class", body: "class ${1:Name}\n\tdef initialize(${2})\n\t\t$0\n\tend\nend" },
  { prefix: "each", detail: "items.each do |x|", body: "${1:items}.each do |${2:x}|\n\t$0\nend" },
  { prefix: "times", detail: "n.times do |i|", body: "${1:n}.times do |${2:i}|\n\t$0\nend" },
  { prefix: "if", detail: "if / else", body: "if ${1:condition}\n\t$2\nelse\n\t$0\nend" },
  { prefix: "while", detail: "while loop", body: "while ${1:condition}\n\t$0\nend" },
  { prefix: "case", detail: "case / when", body: "case ${1:value}\nwhen ${2:1}\n\t$3\nelse\n\t$0\nend" },
  { prefix: "readint", detail: "n = gets.to_i", body: "${1:n} = gets.to_i$0" },
  { prefix: "readnums", detail: "numbers from one line", body: "${1:nums} = gets.split.map(&:to_i)$0" },
];

const SHELL: Snippet[] = [
  { prefix: "shebang", detail: "#!/bin/bash", body: "#!/bin/bash\n$0" },
  { prefix: "if", detail: "if [[ ... ]]; then", body: "if [[ ${1:condition} ]]; then\n\t$0\nfi" },
  { prefix: "ifelse", detail: "if / else", body: "if [[ ${1:condition} ]]; then\n\t$2\nelse\n\t$0\nfi" },
  { prefix: "for", detail: "for x in ...", body: "for ${1:x} in ${2:items}; do\n\t$0\ndone" },
  { prefix: "fori", detail: "for ((i = 0; i < n; i++))", body: "for ((${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)); do\n\t$0\ndone" },
  { prefix: "while", detail: "while read line", body: "while read -r ${1:line}; do\n\t$0\ndone" },
  { prefix: "func", detail: "function", body: "${1:name}() {\n\t$0\n}" },
  { prefix: "case", detail: "case ... esac", body: 'case "\\$${1:value}" in\n\t${2:pattern})\n\t\t$3\n\t\t;;\n\t*)\n\t\t$0\n\t\t;;\nesac' },
  { prefix: "read", detail: "read -r n", body: "read -r ${1:n}$0" },
  { prefix: "arr", detail: "an array", body: "${1:items}=(${2:a b c})$0" },
];

const SQL: Snippet[] = [
  { prefix: "sel", detail: "SELECT ... FROM ...", body: "SELECT ${1:*}\nFROM ${2:table};$0" },
  { prefix: "selw", detail: "SELECT ... WHERE ...", body: "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};$0" },
  { prefix: "ins", detail: "INSERT INTO ... VALUES", body: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});$0" },
  { prefix: "upd", detail: "UPDATE ... SET ... WHERE", body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};$0" },
  { prefix: "del", detail: "DELETE FROM ... WHERE", body: "DELETE FROM ${1:table}\nWHERE ${2:condition};$0" },
  { prefix: "ct", detail: "CREATE TABLE", body: "CREATE TABLE ${1:name} (\n\tid INTEGER PRIMARY KEY,\n\t${2:column} ${3:TEXT}\n);$0" },
  { prefix: "join", detail: "SELECT with JOIN", body: "SELECT ${1:*}\nFROM ${2:a}\nJOIN ${3:b} ON ${3:b}.${4:a_id} = ${2:a}.id;$0" },
  { prefix: "groupby", detail: "GROUP BY with COUNT", body: "SELECT ${1:column}, COUNT(*) AS ${2:total}\nFROM ${3:table}\nGROUP BY ${1:column}\nORDER BY ${2:total} DESC;$0" },
  { prefix: "cte", detail: "WITH ... AS (...)", body: "WITH ${1:name} AS (\n\t$2\n)\nSELECT * FROM ${1:name};$0" },
];

const HTML: Snippet[] = [
  { prefix: "html5", detail: "a whole HTML page", body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8" />\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n\t<title>${1:Page}</title>\n\t<link rel="stylesheet" href="style.css" />\n</head>\n<body>\n\t$0\n\t<script src="script.js"></script>\n</body>\n</html>' },
  { prefix: "link", detail: "<link> a stylesheet", body: '<link rel="stylesheet" href="${1:style.css}" />$0' },
  { prefix: "script", detail: "<script src>", body: '<script src="${1:script.js}"></script>$0' },
  { prefix: "ul", detail: "a list", body: "<ul>\n\t<li>${1:Item}</li>\n\t<li>${2:Item}</li>\n</ul>$0" },
  { prefix: "table", detail: "a table", body: "<table>\n\t<tr>\n\t\t<th>${1:Name}</th>\n\t\t<th>${2:Value}</th>\n\t</tr>\n\t<tr>\n\t\t<td>$3</td>\n\t\t<td>$4</td>\n\t</tr>\n</table>$0" },
  { prefix: "form", detail: "a form with an input", body: '<form>\n\t<label for="${1:name}">${2:Name}</label>\n\t<input id="${1:name}" type="${3:text}" />\n\t<button type="submit">${4:Send}</button>\n</form>$0' },
  { prefix: "img", detail: "<img>", body: '<img src="${1:image.png}" alt="${2:description}" />$0' },
  { prefix: "a", detail: "<a href>", body: '<a href="${1:https://}">${2:link}</a>$0' },
  { prefix: "btn", detail: "<button>", body: '<button id="${1:button}">${2:Click me}</button>$0' },
  { prefix: "div", detail: '<div class="...">', body: '<div class="${1:box}">\n\t$0\n</div>' },
];

const CSS: Snippet[] = [
  { prefix: "flexcenter", detail: "center with flexbox", body: "display: flex;\nalign-items: center;\njustify-content: center;$0" },
  { prefix: "grid", detail: "a grid of columns", body: "display: grid;\ngrid-template-columns: repeat(${1:3}, 1fr);\ngap: ${2:16px};$0" },
  { prefix: "media", detail: "@media (max-width)", body: "@media (max-width: ${1:600px}) {\n\t$0\n}" },
  { prefix: "transition", detail: "transition", body: "transition: ${1:all} ${2:0.2s} ${3:ease};$0" },
  { prefix: "reset", detail: "a small reset", body: "* {\n\tbox-sizing: border-box;\n\tmargin: 0;\n\tpadding: 0;\n}$0" },
  { prefix: "keyframes", detail: "@keyframes", body: "@keyframes ${1:name} {\n\tfrom { $2 }\n\tto { $0 }\n}" },
];

export const SNIPPETS: Record<string, Snippet[]> = {
  java: JAVA,
  python: PYTHON,
  cpp: CPP,
  c: C,
  javascript: JS,
  typescript: TS,
  kotlin: KOTLIN,
  go: GO,
  rust: RUST,
  csharp: CSHARP,
  php: PHP,
  ruby: RUBY,
  shell: SHELL,
  sql: SQL,
  html: HTML,
  css: CSS,
};
