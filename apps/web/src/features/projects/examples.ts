import type { ProjectFile } from "@cw/shared";

/**
 * Small classic programs to start from. Each reads its input, so the tests
 * and the Program Input tab drive it, and each is short enough to follow in
 * the visualizer step by step.
 */
export interface ExampleVersion {
  language: "java" | "python";
  files: ProjectFile[];
}

export interface Example {
  id: string;
  title: string;
  /** One short line on the card. */
  about: string;
  /** Tests: input and the exact expected output. The first input is also the Program Input. */
  tests: { input: string; expected: string }[];
  versions: ExampleVersion[];
}

const java = (code: string): ExampleVersion => ({ language: "java", files: [{ path: "Main.java", content: code }] });
const python = (code: string): ExampleVersion => ({ language: "python", files: [{ path: "main.py", content: code }] });

export const EXAMPLES: Example[] = [
  {
    id: "binary-search",
    title: "Binary search",
    about: "Find a number in a sorted list by halving it",
    tests: [
      { input: "8\n3 4 6 7 9 12 16 17\n9\n", expected: "4\n" },
      { input: "8\n3 4 6 7 9 12 16 17\n5\n", expected: "-1\n" },
      { input: "1\n42\n42\n", expected: "0\n" },
    ],
    versions: [
      java(`import java.util.Scanner;

public class Main {
    static int binarySearch(int[] arr, int target) {
        int low = 0;
        int high = arr.length - 1;
        while (low <= high) {
            int mid = low + (high - low) / 2;
            if (arr[mid] == target) {
                return mid;
            } else if (arr[mid] < target) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return -1;
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        int[] arr = new int[n];
        for (int i = 0; i < n; i++) {
            arr[i] = in.nextInt();
        }
        int target = in.nextInt();
        System.out.println(binarySearch(arr, target));
    }
}
`),
      python(`def binary_search(arr, target):
    low, high = 0, len(arr) - 1
    while low <= high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1


n = int(input())
arr = list(map(int, input().split()))
target = int(input())
print(binary_search(arr, target))
`),
    ],
  },
  {
    id: "bubble-sort",
    title: "Bubble sort",
    about: "Sort by swapping neighbours until nothing moves",
    tests: [
      { input: "5\n5 1 9 2 8\n", expected: "[1, 2, 5, 8, 9]\n" },
      { input: "3\n1 2 3\n", expected: "[1, 2, 3]\n" },
      { input: "4\n-1 -5 3 0\n", expected: "[-5, -1, 0, 3]\n" },
    ],
    versions: [
      java(`import java.util.Arrays;
import java.util.Scanner;

public class Main {
    static void bubbleSort(int[] arr) {
        for (int pass = 0; pass < arr.length - 1; pass++) {
            boolean swapped = false;
            for (int i = 0; i < arr.length - 1 - pass; i++) {
                if (arr[i] > arr[i + 1]) {
                    int tmp = arr[i];
                    arr[i] = arr[i + 1];
                    arr[i + 1] = tmp;
                    swapped = true;
                }
            }
            if (!swapped) {
                break;
            }
        }
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        int[] arr = new int[n];
        for (int i = 0; i < n; i++) {
            arr[i] = in.nextInt();
        }
        bubbleSort(arr);
        System.out.println(Arrays.toString(arr));
    }
}
`),
      python(`def bubble_sort(arr):
    for done in range(len(arr) - 1):
        swapped = False
        for i in range(len(arr) - 1 - done):
            if arr[i] > arr[i + 1]:
                arr[i], arr[i + 1] = arr[i + 1], arr[i]
                swapped = True
        if not swapped:
            break


n = int(input())
arr = list(map(int, input().split()))
bubble_sort(arr)
print(arr)
`),
    ],
  },
  {
    id: "reverse-linked-list",
    title: "Reverse a linked list",
    about: "Turn every arrow in a chain of nodes around",
    tests: [
      { input: "4\n1 2 3 4\n", expected: "4 -> 3 -> 2 -> 1\n" },
      { input: "1\n7\n", expected: "7\n" },
      { input: "3\n10 20 30\n", expected: "30 -> 20 -> 10\n" },
    ],
    versions: [
      java(`import java.util.Scanner;

public class Main {
    static class Node {
        int value;
        Node next;

        Node(int value) {
            this.value = value;
        }
    }

    static Node reverse(Node head) {
        Node prev = null;
        Node current = head;
        while (current != null) {
            Node next = current.next;
            current.next = prev;
            prev = current;
            current = next;
        }
        return prev;
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        Node head = null;
        Node tail = null;
        for (int i = 0; i < n; i++) {
            Node node = new Node(in.nextInt());
            if (head == null) {
                head = node;
            } else {
                tail.next = node;
            }
            tail = node;
        }

        StringBuilder out = new StringBuilder();
        for (Node p = reverse(head); p != null; p = p.next) {
            out.append(p.value);
            if (p.next != null) {
                out.append(" -> ");
            }
        }
        System.out.println(out);
    }
}
`),
      python(`class Node:
    def __init__(self, value):
        self.value = value
        self.next = None


def reverse(head):
    prev = None
    current = head
    while current:
        following = current.next
        current.next = prev
        prev = current
        current = following
    return prev


n = int(input())
values = list(map(int, input().split()))
head = tail = None
for v in values:
    node = Node(v)
    if head is None:
        head = node
    else:
        tail.next = node
    tail = node

parts = []
node = reverse(head)
while node:
    parts.append(str(node.value))
    node = node.next
print(" -> ".join(parts))
`),
    ],
  },
  {
    id: "fibonacci",
    title: "Fibonacci with memory",
    about: "Recursion that remembers what it already worked out",
    tests: [
      { input: "10\n", expected: "55\n" },
      { input: "1\n", expected: "1\n" },
      { input: "50\n", expected: "12586269025\n" },
    ],
    versions: [
      java(`import java.util.HashMap;
import java.util.Map;
import java.util.Scanner;

public class Main {
    static Map<Integer, Long> memo = new HashMap<>();

    static long fib(int n) {
        if (n <= 1) {
            return n;
        }
        if (memo.containsKey(n)) {
            return memo.get(n);
        }
        long result = fib(n - 1) + fib(n - 2);
        memo.put(n, result);
        return result;
    }

    public static void main(String[] args) {
        int n = new Scanner(System.in).nextInt();
        System.out.println(fib(n));
    }
}
`),
      python(`memo = {}


def fib(n):
    if n <= 1:
        return n
    if n in memo:
        return memo[n]
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]


n = int(input())
print(fib(n))
`),
    ],
  },
];
