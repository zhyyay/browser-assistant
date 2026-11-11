param(
    [Parameter(Mandatory = $true)][string]$ExtensionId,
    [Parameter(Mandatory = $true)][string]$HostExe
)

$ErrorActionPreference = "Stop"
$HostName = "com.zhyyay.browser_assistant"
$ManifestPath = Join-Path $PSScriptRoot "..\native-host\$HostName.json"
$HostExe = [System.IO.Path]::GetFullPath($HostExe)
if (-not (Test-Path $HostExe)) { throw "Native Host executable not found: $HostExe" }

$Manifest = @{
    name = $HostName
    description = "Browser Assistant Rust Native Messaging Host"
    path = $HostExe
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath
Write-Host "Registered $HostName"
Write-Host "Manifest: $ManifestPath"
Write-Host "Host: $HostExe"
