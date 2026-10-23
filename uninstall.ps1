$ErrorActionPreference = 'Stop'
$nativeName = 'com.quick_video_saver.local'
foreach ($browserRoot in @('HKCU:\Software\Google\Chrome', 'HKCU:\Software\BraveSoftware\Brave-Browser', 'HKCU:\Software\Microsoft\Edge', 'HKCU:\Software\Chromium')) {
    $registryPath = "$browserRoot\NativeMessagingHosts\$nativeName"
    if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
}
Write-Host 'Quick Video Saver helper unregistered. Downloaded videos were kept.'
Write-Host 'Remove the extension from your browser. You can then delete the extracted Quick-Video-Saver folder.'
