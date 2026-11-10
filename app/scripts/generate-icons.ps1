Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Path $output -Force | Out-Null
foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.ScaleTransform($size / 128.0, $size / 128.0)
  $background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(23, 63, 56))
  $white = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 7)
  $white.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $white.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $red = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(226, 98, 77))
  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $shape.AddArc(0, 0, 32, 32, 180, 90)
  $shape.AddArc(96, 0, 32, 32, 270, 90)
  $shape.AddArc(96, 96, 32, 32, 0, 90)
  $shape.AddArc(0, 96, 32, 32, 90, 90)
  $shape.CloseFigure()
  $graphics.FillPath($background, $shape)
  $graphics.DrawLine($white, 31, 33, 96, 33)
  $graphics.DrawLine($white, 31, 56, 79, 56)
  $graphics.DrawLine($white, 31, 79, 65, 79)
  $graphics.FillEllipse($red, 78, 72, 25, 25)
  $bitmap.Save((Join-Path $output "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $shape.Dispose()
  $red.Dispose()
  $white.Dispose()
  $background.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
