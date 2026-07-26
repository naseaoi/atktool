param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height
)

Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Bitmap]::new($Source)
$targetImage = [System.Drawing.Bitmap]::new(
  $Width,
  $Height,
  [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$graphics = [System.Drawing.Graphics]::FromImage($targetImage)

try {
  $sourceBounds = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
  $targetBounds = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
  $graphics.DrawImage(
    $sourceImage,
    $targetBounds,
    $sourceBounds,
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $targetImage.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $targetImage.Dispose()
  $sourceImage.Dispose()
}
