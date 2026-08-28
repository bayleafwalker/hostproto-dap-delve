// deterministic debug fixture: line numbers are load-bearing for the tests
package main

import (
	"fmt"
	"os"
)

func helper(n int) int {
	total := 0
	for i := 0; i < n; i++ {
		total += i // line 12: breakpoint inside a call
	}
	return total
}

func main() {
	ledger := map[string]int{"capabilities": 17, "verified": 12}
	count := ledger["capabilities"]         // line 19
	fmt.Println("ledger:", count, "capabilities") // line 20
	result := helper(count)                 // line 21
	fmt.Println("result:", result)          // line 22
	if result == 136 {
		os.Exit(0)
	}
	os.Exit(3)
}
