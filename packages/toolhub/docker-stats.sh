#!/usr/bin/env bash
# Monitor Docker CPU/RAM/Network/Block IO usage for Search Engine and Meilisearch

# ANSI color codes
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN} Docker Container Performance Monitor        ${NC}"
echo -e "${CYAN}=============================================${NC}"

echo -e "${GRAY}Searching for active search engine or Meilisearch containers...${NC}"

# Find running container names that might match search or meili
active_containers=$(docker ps --format "{{.Names}}")
target_containers=()

for name in $active_containers; do
    if [[ "$name" == *"meili"* || "$name" == *"search"* ]]; then
        target_containers+=("$name")
    fi
done

if [ ${#target_containers[@]} -eq 0 ]; then
    echo -e "${YELLOW}No active Meilisearch or Search Engine containers found matching '*meili*' or '*search*'.${NC}"
    echo -e "${YELLOW}Falling back to streaming stats for ALL running containers...${NC}"
    echo -e "${GRAY}Press Ctrl+C to exit.\n${NC}"
    docker stats
else
    echo -e "${GREEN}Monitoring active containers: ${target_containers[*]}${NC}"
    echo -e "${GRAY}Press Ctrl+C to exit.\n${NC}"
    docker stats "${target_containers[@]}"
fi
