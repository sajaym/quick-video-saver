param([switch]$PrepareOnly, [switch]$UpdateDownloader)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$helperRoot = Join-Path $packageRoot 'helper'
$runtimeRoot = Join-Path $helperRoot 'runtime'
$cacheRoot = Join-Path $helperRoot 'setup-cache'
$nativeName = 'com.quick_video_saver.local'

function Assert-UnderPackage([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe setup path: $resolved"
    }
    return $resolved
}

function Get-VerifiedTool($Tool) {
    $target = Assert-UnderPackage (Join-Path $cacheRoot $Tool.name)
    $partial = Assert-UnderPackage ($target + '.part')
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $Tool.sha256) { return $target }
    }
    Write-Host "Downloading $($Tool.name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $Tool.url -OutFile $partial -TimeoutSec 900
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Tool.sha256) {
        throw "Checksum verification failed for $($Tool.name). Run setup again on a stable connection."
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    return $target
}

function Expand-Checked([string]$Archive, [string]$Destination) {
    $dest = Assert-UnderPackage $Destination
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveFile = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $archiveFile.Entries) {
            $outFile = [IO.Path]::GetFullPath((Join-Path $dest $entry.FullName))
            if (-not $outFile.StartsWith($dest + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe path inside dependency archive.' }
        }
    } finally { $archiveFile.Dispose() }
    Expand-Archive -LiteralPath $Archive -DestinationPath $dest -Force
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This helper requires 64-bit Windows 10 or Windows 11.' }
    if ($packageRoot -match '[%!]') { throw 'Extract the ZIP to a folder whose name does not contain % or !, then run setup again.' }
    $tools = (Get-Content -LiteralPath (Join-Path $helperRoot 'sources.json') -Raw | ConvertFrom-Json).tools
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $pythonExe = Join-Path $runtimeRoot 'python\python.exe'
    $ytExe = Join-Path $runtimeRoot 'yt-dlp.exe'
    $ffmpegExe = Join-Path $runtimeRoot 'ffmpeg\bin\ffmpeg.exe'
    $denoExe = Join-Path $runtimeRoot 'deno\deno.exe'
    if (-not (Test-Path -LiteralPath $pythonExe)) { Expand-Checked (Get-VerifiedTool $tools.python) (Join-Path $runtimeRoot 'python') }
    if (-not (Test-Path -LiteralPath $ytExe)) { Copy-Item -LiteralPath (Get-VerifiedTool $tools.ytdlp) -Destination $ytExe -Force }
    if (-not (Test-Path -LiteralPath $denoExe)) { Expand-Checked (Get-VerifiedTool $tools.deno) (Join-Path $runtimeRoot 'deno') }
    if (-not (Test-Path -LiteralPath $ffmpegExe)) {
        $unpack = Assert-UnderPackage (Join-Path $cacheRoot 'ffmpeg-unpacked')
        Expand-Checked (Get-VerifiedTool $tools.ffmpeg) $unpack
        $found = Get-ChildItem -LiteralPath $unpack -Filter ffmpeg.exe -Recurse | Select-Object -First 1
        if (-not $found) { throw 'FFmpeg archive did not contain ffmpeg.exe.' }
        $ffRoot = $found.Directory.Parent.FullName
        $ffDest = Assert-UnderPackage (Join-Path $runtimeRoot 'ffmpeg')
        New-Item -ItemType Directory -Path (Join-Path $ffDest 'bin') -Force | Out-Null
        # Only what is needed at run time: the programs, their DLLs and the license.
        Get-ChildItem -LiteralPath (Join-Path $ffRoot 'bin') -File | Where-Object { $_.Name -ne 'ffplay.exe' } | Copy-Item -Destination (Join-Path $ffDest 'bin') -Force
        Get-ChildItem -LiteralPath $ffRoot -Filter 'LICENSE*' -File | Copy-Item -Destination $ffDest -Force
        Remove-Item -LiteralPath $unpack -Recurse -Force
    }
    if ($UpdateDownloader) {
        Write-Host 'Checking the latest official yt-dlp release...'
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -Headers @{'User-Agent'='Quick-Video-Saver/2.0'}
        $asset = $release.assets | Where-Object { $_.name -eq 'yt-dlp.exe' } | Select-Object -First 1
        if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'The release does not provide a SHA-256 digest. Existing downloader was kept.' }
        $update = [pscustomobject]@{name='yt-dlp-update.exe';url=$asset.browser_download_url;sha256=$asset.digest.Substring(7)}
        Copy-Item -LiteralPath (Get-VerifiedTool $update) -Destination $ytExe -Force
        Write-Host "yt-dlp updated to $($release.tag_name)."
    }
    $checkText = & $pythonExe -I (Join-Path $helperRoot 'host.py') --check
    if ($LASTEXITCODE -ne 0) { throw 'The portable Python helper could not start.' }
    $check = $checkText | ConvertFrom-Json
    if (-not $check.ready) { throw 'Some helper files are missing. Extract the complete ZIP or run setup again.' }
    # Read the whole output first: closing the pipe early would make the tool exit with an error code.
    $ytVersion = & $ytExe --version
    if ($LASTEXITCODE -ne 0) { throw 'yt-dlp did not start correctly.' }
    Write-Host "yt-dlp $ytVersion"
    $ffmpegVersion = & $ffmpegExe -version
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg did not start correctly.' }
    Write-Host ($ffmpegVersion | Select-Object -First 1)
    $denoVersion = & $denoExe --version
    if ($LASTEXITCODE -ne 0) { throw 'Deno did not start correctly.' }
    Write-Host ($denoVersion | Select-Object -First 1)
    $extension = Get-Content -LiteralPath (Join-Path $packageRoot 'extension\manifest.json') -Raw | ConvertFrom-Json
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $hash.ComputeHash([Convert]::FromBase64String($extension.key)) } finally { $hash.Dispose() }
    $hex = ([BitConverter]::ToString($bytes)).Replace('-', '').Substring(0, 32).ToLowerInvariant()
    $extensionId = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) })
    $manifest = @{name=$nativeName;description='Quick Video Saver local helper';path=(Join-Path $helperRoot 'launch.cmd');type='stdio';allowed_origins=@("chrome-extension://$extensionId/")}
    $manifestPath = Join-Path $helperRoot ($nativeName + '.json')
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    if ($PrepareOnly) {
        Write-Host "Validation passed. No browser registry changes made. Extension ID: $extensionId"
        exit 0
    }
    # Per-user registration (no administrator rights). Vivaldi and Opera GX read the Chrome entry.
    $registered = @()
    foreach ($browser in @(
        @{Name = 'Google Chrome'; Root = 'HKCU:\Software\Google\Chrome'},
        @{Name = 'Brave'; Root = 'HKCU:\Software\BraveSoftware\Brave-Browser'},
        @{Name = 'Microsoft Edge'; Root = 'HKCU:\Software\Microsoft\Edge'},
        @{Name = 'Chromium'; Root = 'HKCU:\Software\Chromium'})) {
        $registryPath = "$($browser.Root)\NativeMessagingHosts\$nativeName"
        New-Item -Path $registryPath -Force | Out-Null
        Set-Item -Path $registryPath -Value $manifestPath
        $registered += $browser.Name
    }
    Write-Host ''
    Write-Host 'Helper installed. No administrator access was needed.' -ForegroundColor Green
    Write-Host ("Registered for: " + ($registered -join ', '))
    Write-Host "Extension ID: $extensionId"
    Write-Host "Downloads: $($check.folder)"
    Write-Host 'Now restart the browser. In chrome://extensions turn on Developer mode, press Load unpacked and pick the extension folder.'
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
