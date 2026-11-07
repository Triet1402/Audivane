/*
 * Windows process-lifetime host for Audivane.
 *
 * Two modes, both fail closed:
 *
 *   process-host --guard <pid>
 *       Create a kill-on-close Job Object, put the named Electron main process
 *       in it and keep the job handle open. Every child created by that main
 *       process afterwards inherits the job. When the main process exits or
 *       crashes, this helper closes the job and Windows terminates every
 *       remaining member. If the helper itself dies, the kernel closes the job
 *       handle for the same result. The helper is intentionally outside the
 *       job so it can survive an abrupt main-process death.
 *
 *   process-host --run <executable> [args...]
 *       Create a kill-on-close Job Object, start the codec suspended, assign
 *       it to the job, then resume it. The host waits for the codec leader and
 *       closes the job on every exit path, so descendants cannot survive an
 *       early leader exit. Termination of the host also closes the handle and
 *       therefore kills the whole contained codec tree.
 *
 * The host never uses a shell, never parses an argument string and never falls
 * back to an uncontained spawn. Job setup, assignment or resume failure is a
 * hard error.
 */
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define HOST_VERSION L"1.0.0"
#define MAX_COMMAND_LINE 32768

static void fail(LPCWSTR message, DWORD error) {
    if (error == 0) {
        fwprintf(stderr, L"process-host: error: %ls\n", message);
    } else {
        fwprintf(stderr, L"process-host: error: %ls (0x%08lx)\n",
                 message, (unsigned long)error);
    }
    fflush(stderr);
}

static HANDLE create_kill_on_close_job(void) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) return NULL;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        DWORD error = GetLastError();
        CloseHandle(job);
        SetLastError(error);
        return NULL;
    }
    return job;
}

/* CommandLineToArgvW-style quoting used by the MSVC/CRT parser. */
static int append_quoted_arg(wchar_t *command_line, size_t capacity,
                             size_t *used, const wchar_t *argument) {
    size_t backslashes = 0;
    const wchar_t *cursor = argument;
    if (*used > 0) {
        if (*used + 1 >= capacity) return -1;
        command_line[(*used)++] = L' ';
    }
    if (*used + 2 >= capacity) return -1;
    command_line[(*used)++] = L'"';
    while (*cursor != L'\0') {
        if (*cursor == L'\\') {
            backslashes++;
        } else if (*cursor == L'"') {
            if (*used + backslashes * 2 + 2 >= capacity) return -1;
            while (backslashes-- > 0) command_line[(*used)++] = L'\\';
            command_line[(*used)++] = L'\\';
            command_line[(*used)++] = L'"';
            backslashes = 0;
        } else {
            if (*used + backslashes + 2 >= capacity) return -1;
            while (backslashes-- > 0) command_line[(*used)++] = L'\\';
            command_line[(*used)++] = *cursor;
            backslashes = 0;
        }
        cursor++;
    }
    if (*used + backslashes * 2 + 2 >= capacity) return -1;
    while (backslashes-- > 0) {
        command_line[(*used)++] = L'\\';
        command_line[(*used)++] = L'\\';
    }
    command_line[(*used)++] = L'"';
    command_line[*used] = L'\0';
    return 0;
}

static HANDLE duplicate_inheritable(HANDLE source) {
    HANDLE copy = NULL;
    if (source == NULL || source == INVALID_HANDLE_VALUE) return NULL;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(),
                         &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
        return NULL;
    }
    return copy;
}

/* Terminate every remaining member and give the kernel a bounded chance to
 * update job accounting before the caller sees the host exit. */
static void terminate_job_and_wait(HANDLE job) {
    int attempt;
    if (!TerminateJobObject(job, 1)) return;
    for (attempt = 0; attempt < 100; attempt++) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &accounting, sizeof(accounting), NULL)) {
            return;
        }
        if (accounting.ActiveProcesses == 0) return;
        Sleep(10);
    }
}

static BOOL WINAPI ignore_console_break(DWORD type) {
    switch (type) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
            /* The application decides when to exit. Closing the job is the
             * only cleanup path this helper owns. */
            return TRUE;
        default:
            return FALSE;
    }
}

static int guard_main(int argc, wchar_t **argv) {
    wchar_t *end = NULL;
    unsigned long long parsed;
    DWORD pid;
    HANDLE process = NULL;
    HANDLE job = NULL;
    DWORD wait_result;

    if (argc != 3) {
        fail(L"--guard requires exactly one main-process PID", 0);
        return 2;
    }
    if (argv[2][0] == L'\0') {
        fail(L"main-process PID is empty", 0);
        return 2;
    }
    parsed = wcstoull(argv[2], &end, 10);
    if (end == argv[2] || *end != L'\0' || parsed <= 1 || parsed > 0xFFFFFFFFULL) {
        fail(L"main-process PID is not a valid process identifier", 0);
        return 2;
    }
    pid = (DWORD)parsed;

    if (!SetConsoleCtrlHandler(ignore_console_break, TRUE)) {
        fail(L"cannot install guard console handler", GetLastError());
        return 1;
    }
    process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE,
                          FALSE, pid);
    if (process == NULL) {
        fail(L"cannot open the main process", GetLastError());
        return 1;
    }
    job = create_kill_on_close_job();
    if (job == NULL) {
        fail(L"cannot create the desktop lifetime job", GetLastError());
        CloseHandle(process);
        return 1;
    }
    if (!AssignProcessToJobObject(job, process)) {
        DWORD error = GetLastError();
        fail(L"cannot assign the main process to the desktop lifetime job", error);
        CloseHandle(job);
        CloseHandle(process);
        return 1;
    }

    /* The caller must not continue startup until containment is active. */
    if (fputs("ready\n", stdout) == EOF || fflush(stdout) != 0) {
        DWORD error = GetLastError();
        fail(L"cannot report guard readiness", error);
        CloseHandle(job);
        CloseHandle(process);
        return 1;
    }

    wait_result = WaitForSingleObject(process, INFINITE);
    if (wait_result == WAIT_FAILED) {
        DWORD error = GetLastError();
        fail(L"cannot wait for the main process", error);
        CloseHandle(job);
        CloseHandle(process);
        return 1;
    }
    /* Closing a kill-on-close job terminates any descendant still alive. */
    CloseHandle(job);
    CloseHandle(process);
    return 0;
}

static int run_main(int argc, wchar_t **argv) {
    wchar_t *command_line = NULL;
    size_t used = 0;
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    HANDLE job = NULL;
    HANDLE input_handle, output_handle, error_handle;
    DWORD status = 1;
    int index;

    if (argc < 3) {
        fail(L"--run requires an executable path", 0);
        return 2;
    }
    if (argv[2][0] == L'\0') {
        fail(L"--run executable path is empty", 0);
        return 2;
    }

    command_line = (wchar_t *)calloc(MAX_COMMAND_LINE, sizeof(wchar_t));
    if (command_line == NULL) {
        fail(L"cannot allocate the child command line", 0);
        return 1;
    }
    for (index = 2; index < argc; index++) {
        if (append_quoted_arg(command_line, MAX_COMMAND_LINE, &used, argv[index]) != 0) {
            fail(L"child command line is too long", 0);
            free(command_line);
            return 2;
        }
    }

    job = create_kill_on_close_job();
    if (job == NULL) {
        fail(L"cannot create the codec lifetime job", GetLastError());
        free(command_line);
        return 1;
    }

    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);
    /* Codec children do not read stdin, so provide a private inheritable NUL
     * handle rather than requiring the caller's ignored stdin handle. */
    input_handle = CreateFileW(L"NUL", GENERIC_READ,
                               FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                               OPEN_EXISTING, 0, NULL);
    if (input_handle != INVALID_HANDLE_VALUE) {
        if (!SetHandleInformation(input_handle, HANDLE_FLAG_INHERIT,
                                  HANDLE_FLAG_INHERIT)) {
            CloseHandle(input_handle);
            input_handle = NULL;
        }
    } else {
        input_handle = NULL;
    }
    output_handle = duplicate_inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
    error_handle = duplicate_inheritable(GetStdHandle(STD_ERROR_HANDLE));
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input_handle;
    startup.hStdOutput = output_handle;
    startup.hStdError = error_handle;

    ZeroMemory(&process, sizeof(process));
    if (!CreateProcessW(argv[2], command_line, NULL, NULL, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
                        &startup, &process)) {
        fail(L"cannot start the contained process", GetLastError());
        if (input_handle != NULL) CloseHandle(input_handle);
        if (output_handle != NULL) CloseHandle(output_handle);
        if (error_handle != NULL) CloseHandle(error_handle);
        CloseHandle(job);
        free(command_line);
        return 1;
    }
    free(command_line);
    if (input_handle != NULL) CloseHandle(input_handle);
    if (output_handle != NULL) CloseHandle(output_handle);
    if (error_handle != NULL) CloseHandle(error_handle);

    if (!AssignProcessToJobObject(job, process.hProcess)) {
        DWORD error = GetLastError();
        fail(L"cannot assign the contained process to its job", error);
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, INFINITE);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return 1;
    }
    if (ResumeThread(process.hThread) == (DWORD)-1) {
        DWORD error = GetLastError();
        fail(L"cannot resume the contained process", error);
        terminate_job_and_wait(job);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return 1;
    }
    CloseHandle(process.hThread);

    if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_FAILED) {
        fail(L"cannot wait for the contained process", GetLastError());
        terminate_job_and_wait(job);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return 1;
    }
    if (!GetExitCodeProcess(process.hProcess, &status)) {
        DWORD error = GetLastError();
        fail(L"cannot read the contained process status", error);
        terminate_job_and_wait(job);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return 1;
    }
    if (status == STILL_ACTIVE) {
        fail(L"contained process is still active after it was signalled", 0);
        terminate_job_and_wait(job);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return 1;
    }

    /* The leader is gone. Terminate remaining descendants before the host
     * releases its own stdio handles, so an inherited pipe cannot keep the
     * caller waiting on a process that must not survive. */
    terminate_job_and_wait(job);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return (int)status;
}

int wmain(int argc, wchar_t **argv) {
    if (argc >= 2 && wcscmp(argv[1], L"--version") == 0) {
        wprintf(L"audivane-process-host %ls\n", HOST_VERSION);
        return 0;
    }
    if (argc >= 2 && wcscmp(argv[1], L"--guard") == 0) {
        return guard_main(argc, argv);
    }
    if (argc >= 2 && wcscmp(argv[1], L"--run") == 0) {
        return run_main(argc, argv);
    }
    fail(L"usage: process-host --guard <pid> | --run <executable> [args...]", 0);
    return 2;
}
