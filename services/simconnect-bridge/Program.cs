// FlightDeck.SimConnectBridge — Program.cs
//
// A .NET 8 console app that connects to Microsoft Flight Simulator 2024
// through SimConnect, samples eight aircraft state variables at 1 Hz, and
// POSTs each sample as JSON to the FlightDeck planning API.
//
//     POST {apiUrl}  (default: http://localhost:8124/api/telemetry)
//     {
//       "lat":            40.6413,    // PLANE LATITUDE, degrees  (null if not provided)
//       "lon":            -73.7781,   // PLANE LONGITUDE, degrees (null if not provided)
//       "altitudeFt":     35000,      // PLANE ALTITUDE, feet     (null if not provided)
//       "groundspeedKt":   450,        // GROUND VELOCITY, knots  (null if not provided)
//       "headingDeg":     92.5,       // PLANE HEADING DEGREES TRUE (null if not provided)
//       "verticalSpeedFpm": -1200,    // VERTICAL SPEED, ft/min   (null if not provided)
//       "onGround":       false,      // SIM ON GROUND            (null if not provided)
//       "autopilotMaster": true       // AUTOPILOT MASTER         (null if not provided)
//     }
//
// Core honesty rule: values that the sim does not provide are posted as
// `null` — they are NEVER synthesized, interpolated, or guessed. If the
// bridge is not running, the planning API marks telemetry as stale after
// 5 seconds and the FlightDeck UI shows "Not connected" instead of data.
//
// Ctrl+C shuts the bridge down gracefully (SimConnect is closed/disposed).

using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json.Serialization;
using Microsoft.FlightSimulator.SimConnect;

namespace FlightDeck.SimConnectBridge;

// ---------------------------------------------------------------------------
// Telemetry payload — one data-definition slot per struct field.
// ---------------------------------------------------------------------------
// The fields MUST be declared in exactly the same order as the matching
// AddToDataDefinition() calls below. SimConnect fills the struct by offset;
// reordering fields (or definitions) without the other silently scrambles
// the data, so keep the two lists visually adjacent and in lockstep.
//
// Layout is Sequential/Pack=1 (Ansi) to mirror how the managed client
// marshals the native SIMCONNECT_RECV_SIMOBJECT_DATA block.
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi, Pack = 1)]
internal struct AircraftState
{
    public double Latitude;        // PLANE LATITUDE   (degrees)
    public double Longitude;       // PLANE LONGITUDE  (degrees)
    public double AltitudeFeet;    // PLANE ALTITUDE   (feet)
    public double GroundspeedKnots;// GROUND VELOCITY  (knots)
    public double HeadingDegrees;  // PLANE HEADING DEGREES TRUE (degrees)
    public double VerticalSpeedFpm;// VERTICAL SPEED   (feet per minute)
    public int OnGround;           // SIM ON GROUND    (bool -> 0/1 as INT32)
    public int AutopilotMaster;    // AUTOPILOT MASTER (bool -> 0/1 as INT32)
}

// ---------------------------------------------------------------------------
// JSON sample posted to the planning API.
// ---------------------------------------------------------------------------
// All fields are nullable: a field we have no real value for is posted as
// null, never fabricated. In practice the eight simvars below always arrive
// from the sim; the nullability exists so the contract is explicit.
internal sealed record TelemetrySample(
    [property: JsonPropertyName("lat")] double? Lat,
    [property: JsonPropertyName("lon")] double? Lon,
    [property: JsonPropertyName("altitudeFt")] double? AltitudeFt,
    [property: JsonPropertyName("groundspeedKt")] double? GroundspeedKt,
    [property: JsonPropertyName("headingDeg")] double? HeadingDeg,
    [property: JsonPropertyName("verticalSpeedFpm")] double? VerticalSpeedFpm,
    [property: JsonPropertyName("onGround")] bool? OnGround,
    [property: JsonPropertyName("autopilotMaster")] bool? AutopilotMaster);

internal static class Program
{
    // Message-loop constant from the classic SimConnect console-app pattern.
    private const int WM_USER_SIMCONNECT = 0x0402;

    private enum Definition : uint { Aircraft = 0 }
    private enum Request : uint { Aircraft = 0 }

    private static string _apiUrl = "http://localhost:8124/api/telemetry";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private static readonly CancellationTokenSource Cts = new();

    // Guards: one POST in flight at a time (a slow API must not back up the
    // 1 Hz sample loop), and log POST failures at most once per 30 seconds.
    private static int _postInFlight;
    private static DateTime _lastPostErrorLog = DateTime.MinValue;

    private static async Task<int> Main(string[] args)
    {
        if (!ParseArgs(args))
            return 2; // --help or a usage error

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true; // stay in Main so we can close SimConnect cleanly
            Cts.Cancel();
        };

        Console.WriteLine("FlightDeck SimConnect bridge");
        Console.WriteLine($"Telemetry endpoint: {_apiUrl}");
        Console.WriteLine("Press Ctrl+C to stop.");

        // Connection loop: if MSFS is not running, SimConnect.Open throws
        // (COMException). Retry with backoff until connected or cancelled.
        var backoffSeconds = 2;
        while (!Cts.IsCancellationRequested)
        {
            try
            {
                await RunBridgeAsync(Cts.Token);
                backoffSeconds = 2; // a clean run resets the backoff
            }
            catch (COMException ex)
            {
                Log($"SimConnect connection failed (MSFS 2024 may not be running): {ex.Message}");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log($"Bridge error: {ex.Message}");
            }

            if (Cts.IsCancellationRequested)
                break;

            backoffSeconds = Math.Min(backoffSeconds * 2, 30); // 2,4,8,16,30,30,...
            Log($"Retrying in {backoffSeconds}s...");
            try { await Task.Delay(TimeSpan.FromSeconds(backoffSeconds), Cts.Token); }
            catch (OperationCanceledException) { break; }
        }

        Log("Bridge stopped.");
        return 0;
    }

    // --- command-line handling --------------------------------------------

    private static bool ParseArgs(string[] args)
    {
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--help":
                case "-h":
                    PrintUsage();
                    return false;
                case "--api-url":
                    if (i + 1 >= args.Length)
                    {
                        Console.Error.WriteLine("error: --api-url requires a URL argument.");
                        PrintUsage();
                        return false;
                    }
                    _apiUrl = args[++i];
                    break;
                default:
                    Console.Error.WriteLine($"error: unknown argument '{args[i]}'.");
                    PrintUsage();
                    return false;
            }
        }
        return true;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            Usage: FlightDeck.SimConnectBridge [--api-url <url>] [--help]

              --api-url <url>   Planning API telemetry endpoint.
                                Default: http://localhost:8124/api/telemetry
              --help, -h        Show this help.

            Each 1 Hz sample is POSTed as JSON:
              { lat, lon, altitudeFt, groundspeedKt, headingDeg,
                verticalSpeedFpm, onGround, autopilotMaster }
            A value the sim does not provide is sent as null, never synthesized.
            """);
    }

    // --- the bridge itself -------------------------------------------------

    private static async Task RunBridgeAsync(CancellationToken token)
    {
        // No window handle: this is a console app, so we poll via
        // ReceiveMessage() in the loop below (the classic no-pump pattern).
        var sim = new SimConnect("FlightDeck Bridge", IntPtr.Zero, WM_USER_SIMCONNECT, null, 0);
        Log("Connected to MSFS 2024 via SimConnect.");

        try
        {
            // Register the data definition. Field order MUST match the
            // AircraftState struct field order (see the comment on it).
            sim.AddToDataDefinition(Definition.Aircraft, "PLANE LATITUDE", "degrees",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "PLANE LONGITUDE", "degrees",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "PLANE ALTITUDE", "feet",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "GROUND VELOCITY", "knots",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "PLANE HEADING DEGREES TRUE", "degrees",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "VERTICAL SPEED", "feet per minute",
                SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            // Boolean simvars arrive as 0/1 integers; convert to bool by hand.
            sim.AddToDataDefinition(Definition.Aircraft, "SIM ON GROUND", "bool",
                SIMCONNECT_DATATYPE.INT32, 0.0f, SimConnect.SIMCONNECT_UNUSED);
            sim.AddToDataDefinition(Definition.Aircraft, "AUTOPILOT MASTER", "bool",
                SIMCONNECT_DATATYPE.INT32, 0.0f, SimConnect.SIMCONNECT_UNUSED);

            sim.RegisterDataDefineStruct<AircraftState>(Definition.Aircraft);

            // Ask for the user's aircraft at 1 Hz (SIMCONNECT_PERIOD.SECOND).
            sim.RequestDataOnSimObject(
                Request.Aircraft,
                Definition.Aircraft,
                SimConnect.SIMCONNECT_OBJECT_ID_USER,
                SIMCONNECT_PERIOD.SECOND,
                SIMCONNECT_DATA_REQUEST_FLAG.DEFAULT,
                0, 0, 0);

            // Each 1 Hz sample is posted to the planning API. We fire the
            // POST on a background task and drop the sample if the previous
            // POST is still in flight (never queue samples behind a slow API).
            sim.OnRecvSimobjectData += async (_, data) =>
            {
                var state = (AircraftState)data.dwData[0];
                await PostSampleAsync(SampleFrom(state), token);
            };

            // The sim closed or quit underneath us -> break out and reconnect.
            var quitReceived = new TaskCompletionSource();
            sim.OnRecvQuit += (_, _) => quitReceived.TrySetResult();

            // Poll the SimConnect message queue. A COMException here means
            // the connection dropped (sim crashed / was closed).
            while (!token.IsCancellationRequested && !quitReceived.Task.IsCompleted)
            {
                sim.ReceiveMessage();
                await Task.Delay(1, token); // yield; samples arrive via the event above
            }

            if (quitReceived.Task.IsCompleted)
                Log("MSFS 2024 quit; will reconnect.");
        }
        finally
        {
            // Dispose closes the SimConnect connection gracefully.
            sim.Dispose();
            Log("SimConnect connection closed.");
        }
    }

    // Convert the raw struct into the nullable JSON contract.
    // (Int fields are 0/1 from the sim; `!= 0` turns them into true bools.)
    private static TelemetrySample SampleFrom(AircraftState s) => new(
        Lat: s.Latitude,
        Lon: s.Longitude,
        AltitudeFt: s.AltitudeFeet,
        GroundspeedKt: s.GroundspeedKnots,
        HeadingDeg: s.HeadingDegrees,
        VerticalSpeedFpm: s.VerticalSpeedFpm,
        OnGround: s.OnGround != 0,
        AutopilotMaster: s.AutopilotMaster != 0);

    private static async Task PostSampleAsync(TelemetrySample sample, CancellationToken token)
    {
        if (Interlocked.CompareExchange(ref _postInFlight, 1, 0) != 0)
            return; // a previous POST is still running; drop this sample

        try
        {
            using var response = await Http.PostAsJsonAsync(_apiUrl, sample, token);
            response.EnsureSuccessStatusCode();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Log at most once per 30 seconds so a dead API doesn't spam.
            if (DateTime.UtcNow - _lastPostErrorLog > TimeSpan.FromSeconds(30))
            {
                _lastPostErrorLog = DateTime.UtcNow;
                Log($"Telemetry POST failed: {ex.Message} (further failures are quiet for 30s)");
            }
        }
        finally
        {
            Interlocked.Exchange(ref _postInFlight, 0);
        }
    }

    private static void Log(string message) =>
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");
}
