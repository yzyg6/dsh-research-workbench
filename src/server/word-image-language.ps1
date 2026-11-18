param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$ocrType = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$language = $ocrType::AvailableRecognizerLanguages | Where-Object LanguageTag -Like 'zh-*' | Select-Object -First 1
if (!$language) { '{}' ; exit 0 }
$ocr = $ocrType::TryCreateFromLanguage($language)
if (!$ocr) { '{}' ; exit 0 }

$storageFile = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$access = [Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
$streamType = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$decoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$transformType = [Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$format = [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$alpha = [Windows.Graphics.Imaging.BitmapAlphaMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$orientation = [Windows.Graphics.Imaging.ExifOrientationMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$color = [Windows.Graphics.Imaging.ColorManagementMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$ocrResult = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Get-Result($Operation, [Type]$Type) {
  $task = $asTask.MakeGenericMethod($Type).Invoke($null, @($Operation))
  if (!$task.Wait(3000)) { throw 'Image check timed out' }
  $task.Result
}

$images = Get-Content -LiteralPath $Manifest -Raw -Encoding utf8 | ConvertFrom-Json
$states = @{}
foreach ($image in $images) {
  $stream = $null
  $bitmap = $null
  try {
    $file = Get-Result ($storageFile::GetFileFromPathAsync($image.path)) $storageFile
    $stream = Get-Result ($file.OpenAsync($access::Read)) $streamType
    $decoder = Get-Result ($decoderType::CreateAsync($stream)) $decoderType
    $transform = [Activator]::CreateInstance($transformType)
    $factor = [Math]::Min(1, $ocrType::MaxImageDimension / [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    if ($factor -lt 1) {
      $transform.ScaledWidth = [Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $factor))
      $transform.ScaledHeight = [Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $factor))
    }
    $bitmap = Get-Result ($decoder.GetSoftwareBitmapAsync($format::Bgra8, $alpha::Premultiplied, $transform, $orientation::IgnoreExifOrientation, $color::DoNotColorManage)) $bitmapType
    $result = Get-Result ($ocr.RecognizeAsync($bitmap)) $ocrResult
    # Isolated CJK strokes can be the OCR rendering of Latin letters such as I.
    $letters = $result.Text -replace '[\u4e28\u4e36\u4e85\u4e3f\u4e00\u3007]', ''
    $states[$image.part] = if ($letters -match '[\u3400-\u9fff\uf900-\ufaff]') { 'chinese' }
      elseif ($letters -match '[A-Za-z0-9]') { 'clear' } else { 'unknown' }
  } catch {
    $states[$image.part] = 'unknown'
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}
$states | ConvertTo-Json -Compress
