#!/bin/bash

# Target directory
TARGET_DIR="/Users/stevendyke/aptos-core/testsuite"
YAML_FILE="docker-compose.yaml"
TARGET_SERVICE="indexer"

# Ensure the target directory exists
mkdir -p "$TARGET_DIR"

# Check if the docker-compose file exists
if [ ! -f "$YAML_FILE" ]; then
    echo "Error: $YAML_FILE not found in the current directory."
    exit 1
fi

echo "Scanning /Users/stevendyke for artifacts..."

# Recursively find both .abi and .bin files inside the user folder
find /Users/stevendyke \( -name "*.abi" -o -name "*.bin" \) -print0 | while read -r -d '' file; do
    
    # Extract just the filename
    filename=$(basename "$file")
    
    # Skip processing if the file is already inside the destination folder
    if [[ "$file" == "$TARGET_DIR"* ]]; then
        continue
    fi

    # Move the file to the target directory
    mv "$file" "$TARGET_DIR/"
    
    # Format a clean environment variable name (e.g., ARTIFACT_TOKEN_ABI)
    var_name=$(echo "ARTIFACT_${filename}" | tr '.-' '__' | tr '[:lower:]' '[:upper:]')
    
    # Construct the environment line with standard 6-space indentation
    env_line="      - $var_name=/app/artifacts/$filename"
    
    # Use macOS-compatible sed syntax to inject lines below 'environment:' under TARGET_SERVICE
    sed -i '' "/^[[:space:]]*${TARGET_SERVICE}:/,/^[[:space:]]*[a-zA-Z0-9_-]\+:/ {
        /^[[:space:]]*environment:/ a\\
$env_line
    }" "$YAML_FILE"
    
    echo "Moved and injected: $filename"
done

echo "Deep scan complete. All artifacts successfully moved and registered."
