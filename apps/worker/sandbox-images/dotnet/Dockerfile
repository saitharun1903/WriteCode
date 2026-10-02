# The C# compiler called directly: no project file and no MSBuild, so a program
# builds in about a second inside a small sandbox. `cw-csc <out.dll> <sources>`
# compiles the sources into one program against the .NET 8 reference
# assemblies, with the usual namespaces already imported (as a new console
# project has them), and writes the file `dotnet` needs to run it.
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine
# No telemetry or banner; one small heap; and no executable-memory mapping file (it is larger than a sandbox may write).
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_gcServer=0 DOTNET_GCgen0size=4000000 DOTNET_TieredPGO=0 DOTNET_EnableDiagnostics=0 DOTNET_EnableWriteXorExecute=0
RUN set -eu; mkdir -p /opt/cs; \
    ln -s "$(ls -d /usr/share/dotnet/sdk/*/Roslyn/bincore | head -1)/csc.dll" /opt/cs/csc.dll; \
    for f in "$(ls -d /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/*/ref/net8.0 | head -1)"/*.dll; do echo "-r:$f"; done > /opt/cs/refs.rsp; \
    printf '%s\n' '{"runtimeOptions":{"tfm":"net8.0","framework":{"name":"Microsoft.NETCore.App","version":"8.0.0"},"configProperties":{"System.GC.Server":false,"System.GC.Concurrent":false,"System.Runtime.TieredPGO":false}}}' > /opt/cs/runtimeconfig.json; \
    printf '%s\n' 'global using System;' 'global using System.Collections.Generic;' 'global using System.IO;' 'global using System.Linq;' 'global using System.Text;' 'global using System.Threading;' 'global using System.Threading.Tasks;' > /opt/cs/Usings.cs; \
    printf '%s\n' '#!/bin/sh' 'out="$1"; shift' 'cp /opt/cs/runtimeconfig.json "${out%.dll}.runtimeconfig.json"' 'exec dotnet /opt/cs/csc.dll -nologo -langversion:latest -nullable:disable -nowarn:CS8933 -debug:portable -optimize- -target:exe @/opt/cs/refs.rsp "-out:$out" /opt/cs/Usings.cs "$@"' > /usr/local/bin/cw-csc; \
    chmod +x /usr/local/bin/cw-csc
