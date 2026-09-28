import { describe, expect, it } from "vitest";
import { javaReadInput, pythonReadInput } from "./read-input";

const CANDIES = `public class Candies {
    public static int search(int[] arr, int s) {
        int low = 0;
        return -1;
    }
    public static void main(String[] args) {
        int arr[] = {3,4,6,7,9,12,16,17};
        int n = 5;

        System.out.println(search(arr,n));
    }
}
`;

describe("Java: values fixed in main are read from input", () => {
  it("rewrites the user's Candies program, adds the Scanner and its import, and keeps the output the same", () => {
    const r = javaReadInput(CANDIES)!;
    expect(r.names).toEqual(["arr", "n"]);
    expect(r.input).toBe("8\n3 4 6 7 9 12 16 17\n5\n");
    expect(r.code).toBe(`import java.util.Scanner;

public class Candies {
    public static int search(int[] arr, int s) {
        int low = 0;
        return -1;
    }
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int[] arr = new int[in.nextInt()];
        for (int i = 0; i < arr.length; i++) arr[i] = in.nextInt();
        int n = in.nextInt();

        System.out.println(search(arr,n));
    }
}
`);
  });

  it("reuses an existing Scanner, handles several types, and leaves values inside loops and expressions alone", () => {
    const code = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String name = "Ada";
        double rate = 1.5;
        long big = 10000000000L;
        char grade = 'A';
        int total = 2 + 3;
        for (int k = 0; k < 3; k++) {
            int inside = 7;
        }
    }
}
`;
    const r = javaReadInput(code)!;
    expect(r.names).toEqual(["name", "rate", "big", "grade"]);
    expect(r.input).toBe("Ada\n1.5\n10000000000\nA\n");
    expect(r.code).toContain('        String name = sc.next();\n        double rate = sc.nextDouble();\n        long big = sc.nextLong();\n        char grade = sc.next().charAt(0);');
    expect(r.code).toContain("        int total = 2 + 3;");
    expect(r.code).toContain("            int inside = 7;");
    expect(r.code.match(/new Scanner/g)).toHaveLength(1);
  });

  it("picks a loop variable that is free, and returns null when there is nothing to read", () => {
    const code = "public class Main {\n    public static void main(String[] args) {\n        int i = 1;\n        int[] a = {1, 2};\n        System.out.println(i + a[0]);\n    }\n}\n";
    expect(javaReadInput(code)!.code).toContain("for (int j = 0; j < a.length; j++) a[j] = in.nextInt();");
    expect(javaReadInput('public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}\n')).toBeNull();
    expect(javaReadInput('public class Main {\n    public static void main(String[] args) {\n        String s = "two words";\n    }\n}\n')).toBeNull();
  });
});

describe("Python: top-level values are read from input", () => {
  it("rewrites numbers, words and lists at the top level and in main()", () => {
    const code = `def search(arr, s):
    low = 0
    return -1


arr = [3, 4, 6, 7]
n = 5
name = "Ada"
print(search(arr, n), name)
`;
    const r = pythonReadInput(code)!;
    expect(r.names).toEqual(["arr", "n", "name"]);
    expect(r.input).toBe("3 4 6 7\n5\nAda\n");
    expect(r.code).toContain("arr = list(map(int, input().split()))\nn = int(input())\nname = input()\n");
    expect(r.code).toContain("    low = 0");

    const inMain = 'def main():\n    x = 2.5\n    print(x)\n\n\nif __name__ == "__main__":\n    main()\n';
    expect(pythonReadInput(inMain)).toEqual({ code: 'def main():\n    x = float(input())\n    print(x)\n\n\nif __name__ == "__main__":\n    main()\n', input: "2.5\n", names: ["x"] });
    expect(pythonReadInput("print('hi')\n")).toBeNull();
  });
});
