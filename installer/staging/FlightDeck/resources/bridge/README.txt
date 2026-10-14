Optional: SimConnect bridge (built on Windows)
=============================================
Build it on your Windows PC with the .NET 8 SDK:

  cd services/simconnect-bridge
  dotnet publish -c Release -r win-x64 --self-contained false -o publish

Then copy publish/FlightDeck.SimConnectBridge.exe here.
FlightDeck's API starts it automatically (hidden) and stops it on Quit.
Without it, Live Telemetry simply reports disconnected.
