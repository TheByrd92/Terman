# Generates build\icon.ico -- a 256x256 PNG-framed icon (Vista ICO format).
# Run only when the icon needs regenerating: pwsh -File build\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

# rounded dark window body
$pad = 14
$radius = 42
$rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc(($rect.Right - $radius), $rect.Y, $radius, $radius, 270, 90)
$path.AddArc(($rect.Right - $radius), ($rect.Bottom - $radius), $radius, $radius, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $radius), $radius, $radius, 90, 90)
$path.CloseFigure()

$body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 26, 36))
$g.FillPath($body, $path)

$edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 58, 64, 90)), 5
$g.DrawPath($edge, $path)

# title strip
$strip = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 38, 54))
$clip = $g.Save()
$g.SetClip($path)
$g.FillRectangle($strip, $rect.X, $rect.Y, $rect.Width, 40)
$g.Restore($clip)

# accent tab on the strip
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 110, 168, 254))
$g.FillRectangle($accent, ($rect.X + 16), ($rect.Y + 28), 52, 6)

# ">_" prompt
$font = New-Object System.Drawing.Font 'Consolas', 88, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 78, 201, 165))
$g.DrawString('>', $font, $green, 44, 96)
# cursor bar, aligned to the bottom of the '>' glyph
$g.FillRectangle($accent, 116, 158, 66, 14)

$g.Dispose()

# --- write ICO with a single PNG-compressed 256x256 frame ---
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$out = Join-Path $PSScriptRoot 'icon.ico'
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0)      # reserved
$bw.Write([uint16]1)      # type: icon
$bw.Write([uint16]1)      # image count
$bw.Write([byte]0)        # width  0 => 256
$bw.Write([byte]0)        # height 0 => 256
$bw.Write([byte]0)        # palette
$bw.Write([byte]0)        # reserved
$bw.Write([uint16]1)      # color planes
$bw.Write([uint16]32)     # bits per pixel
$bw.Write([uint32]$png.Length)
$bw.Write([uint32]22)     # offset: 6-byte header + 16-byte dir entry
$bw.Write($png)
$bw.Flush(); $bw.Dispose(); $fs.Dispose()

Write-Host ("wrote {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length)
