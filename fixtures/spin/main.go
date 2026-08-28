package main

import "time"

func main() {
	i := 0
	for {
		i++
		time.Sleep(10 * time.Millisecond)
	}
}
