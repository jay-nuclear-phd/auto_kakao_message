param([Parameter(Mandatory)][string]$Title, [int]$TimeoutSec = 5)
# 제목이 정확히 일치하는 채팅방 창이 없으면 카톡 메인 창의 채팅 목록 검색으로 연다.
# 열린 창 제목이 정확히 일치하지 않으면 실패로 끝낸다 (엉뚱한 방으로 보내지 않게).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class KO {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EP f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h){ var c=new StringBuilder(256); GetClassName(h,c,256); return c.ToString(); }
  static string Txt(IntPtr h){ var t=new StringBuilder(512); GetWindowText(h,t,512); return t.ToString(); }
  public static IntPtr FindTop(string title){ IntPtr r=IntPtr.Zero; EnumWindows((h,l)=>{
      if(Cls(h)=="EVA_Window_Dblclk" && Txt(h)==title){r=h;return false;} return true;},IntPtr.Zero); return r; }
  public static IntPtr FindChildPrefix(IntPtr p, string prefix){ IntPtr r=IntPtr.Zero; EnumChildWindows(p,(h,l)=>{
      if(Txt(h).StartsWith(prefix)){r=h;return false;} return true;},IntPtr.Zero); return r; }
}
"@
$WM_SETTEXT = 0x000C; $WM_KEYDOWN = 0x0100; $WM_KEYUP = 0x0101; $VK_RETURN = [IntPtr]0x0D

$w = [KO]::FindTop($Title)
if ($w -ne [IntPtr]::Zero) { "already open '$Title' (hwnd=$w)"; exit 0 }

$main = [KO]::FindTop("KakaoTalk")
if ($main -eq [IntPtr]::Zero) { Write-Error "카톡 메인 창을 찾을 수 없음 (카톡이 실행·로그인되어 있어야 함)"; exit 1 }
$view = [KO]::FindChildPrefix($main, "ChatRoomListView")
if ($view -eq [IntPtr]::Zero) { Write-Error "채팅 목록을 찾을 수 없음"; exit 1 }
$edit = [KO]::FindWindowEx($view, [IntPtr]::Zero, "Edit", $null)
if ($edit -eq [IntPtr]::Zero) { Write-Error "채팅 목록 검색칸을 찾을 수 없음"; exit 1 }

[void][KO]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $Title)
Start-Sleep -Milliseconds 800
[void][KO]::PostMessage($edit, $WM_KEYDOWN, $VK_RETURN, [IntPtr]::Zero)
[void][KO]::PostMessage($edit, $WM_KEYUP, $VK_RETURN, [IntPtr]::Zero)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
do { Start-Sleep -Milliseconds 300; $w = [KO]::FindTop($Title) } while ($w -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
[void][KO]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, "")   # 검색어 지우기
if ($w -eq [IntPtr]::Zero) { Write-Error "채팅방을 열지 못함: $Title"; exit 1 }
"opened '$Title' (hwnd=$w)"
