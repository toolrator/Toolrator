# docker-stats.ps1
# Monitor Docker CPU/RAM/Network/Block IO usage for Search Engine and Meilisearch

$MeiliContainer = "mcp-se-meilisearch"
$SearchContainer = "toolhub"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Docker Container Performance Monitor        " -ForegroundColor Cyan -Bold
Write-Host "=============================================" -ForegroundColor Cyan

# Find running container names that might match search or meili
Write-Host "Searching for active search engine or Meilisearch containers..." -ForegroundColor Gray

$ActiveContainers = docker ps --format "{{.Names}}"
$TargetContainers = @()

foreach ($Name in $ActiveContainers) {
    if ($Name -like "*meili*" -or $Name -like "*search*") {
        $TargetContainers += $Name
    }
}

if ($TargetContainers.Count -eq 0) {
    Write-Host "No active Meilisearch or Search Engine containers found matching '*meili*' or '*search*'." -ForegroundColor Yellow
    Write-Host "Falling back to streaming stats for ALL running containers..." -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to exit.`n" -ForegroundColor Gray
    docker stats
} else {
    Write-Host "Monitoring active containers: $($TargetContainers -join ', ')" -ForegroundColor Green
    Write-Host "Press Ctrl+C to exit.`n" -ForegroundColor Gray
    docker stats $TargetContainers
}
