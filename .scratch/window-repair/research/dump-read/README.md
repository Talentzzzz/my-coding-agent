# 读转储的脚本与它的输出

`read.ps1` 是票 02 留下的读法：本机既没有 cdb/windbg，也没有 .NET SDK，而
`%LOCALAPPDATA%\CrashDumps` 里那两份 `electron.exe.*.dmp`（2026-10-13 23:41）是那次崩溃**仅存的**
现场。minidump 的格式是公开且小的——头、流目录、每种流各一个结构——所以这个脚本直接按偏移读它，
回答四件事：**异常码与出错地址**、**那个地址属于哪个模块**、**崩溃线程的栈在不在文件里**、
以及**那段栈上的可打印字符串**（Chromium 自己的 `FATAL` 行就在那里——这是能把崩溃说成"它自己说的
话"而不是猜的唯一依据）。

```powershell
# 注意：仓库里没有 pwsh，用 Windows PowerShell 跑（本 session 的 shell 就是它）
& .\read.ps1 -Dumps @("$env:LOCALAPPDATA\CrashDumps\electron.exe.11344.dmp",
                      "$env:LOCALAPPDATA\CrashDumps\electron.exe.26804.dmp")
```

`dump-read.txt` 是 2026-10-16 那次运行的原样输出，含每份转储的
`--- strings on the crashing thread's stack ---` 与
`--- runs that look like a negative exit code ---` 两段。结论写在
`../minimal-switch-set.md`；这里只留工具与原始记录。

**读不出来的部分（诚实记下）**：

1. **完整退出码读不出来。** 栈上是 `-1073741` 后面跟一个非可打印字节；脚本专门扫了一遍"看起来像负
   退出码的可打印串"，两份转储都只给出 `-1073741`。`-1073741819`（= `0xC0000005`）**不在**这两份
   文件里——它来自用户 10/13 的记录，是**跨来源拼接**的结果，不是从这里读出来的。
2. **GPU 子进程自己的转储不在手上。** 它崩在另一个进程里，这里只有浏览器主进程那两份。所以
   "GPU 进程里是哪个模块越界的"**这两份文件回答不了**，不要从它们推。
3. **没有栈回溯（stack walk）。** 只做了"把栈当字节扫出可打印串"这一件事，**没有**逐帧函数名。所以
   `electron.exe +0x72D4CB9` 只是"出错地址落在哪个模块"，不是"哪个函数"。

**脚本编码的坑（本票踩过一次）**：Windows PowerShell 5.1 把**无 BOM 的 `.ps1`** 按机器 ANSI 代码页
读，脚本里的中文会变成乱码并**解析失败**（报的是"字符串缺少终止符"这类看不懂的错）。所以这个文件是
**纯 ASCII**，中文只出现在这份 `.md` 里。
