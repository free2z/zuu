#!/bin/bash

# Check if the user provided the path to the Git repository
if [ -z "$1" ]; then
  echo "Usage: $0 /path/to/git/repo"
  exit 1
fi

# Navigate to the specified repository
cd "$1" || exit

# Ensure the directory is a Git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Error: $1 is not a Git repository."
  exit 1
fi

echo "Analyzing the Git repository at $1..."

# List all objects in the repository and sort by size, capturing the SHA and size
results=$(git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | grep '^blob' \
  | sort --numeric-sort --key=3 -r \
  | head -n 10)

# Prepare the output header
echo -e "\nLargest files in the Git history:"
printf "%-15s %-40s %s\n" "Size (KB)" "SHA" "Path"

# Process each result to find the file path
echo "$results" | while read -r type sha size rest; do
  # Convert size to KB
  size_kb=$(echo "scale=2; $size/1024" | bc)

  # Find the file path in the commit history
  path=$(git rev-list --all --objects | grep "$sha" | cut -d' ' -f2- | head -n 1)

  # Print the result
  printf "%-15s %-40s %s\n" "$size_kb KB" "$sha" "$path"
done
