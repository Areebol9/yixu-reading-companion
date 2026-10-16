#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdio.h>
#include "quickjs.h"

typedef struct {
    JSRuntime *runtime;
    JSContext *context;
    JNIEnv *env; /* Used only during calls on the owning Java handler thread. */
    jobject peer;
    jmethodID send, sync;
    int64_t deadline;
} Core;

static int64_t now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int interrupt(JSRuntime *rt, void *opaque) {
    Core *core = opaque;
    return now_ms() > core->deadline;
}
static jbyteArray bytes(JNIEnv *env, const char *value, size_t length) {
    jbyteArray result = (*env)->NewByteArray(env, (jsize)length);
    if (result) (*env)->SetByteArrayRegion(env, result, 0, (jsize)length, (const jbyte *)value);
    return result;
}
#define ERROR_BYTES(env, text) bytes(env, text, sizeof(text) - 1)
static JSValue send_host(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    Core *core = JS_GetContextOpaque(ctx);
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argc ? argv[0] : JS_UNDEFINED);
    if (!text) return JS_EXCEPTION;
    jbyteArray message = bytes(core->env, text, length);
    JS_FreeCString(ctx, text);
    if (!message) return JS_ThrowInternalError(ctx, "Native message allocation failed");
    (*core->env)->CallVoidMethod(core->env, core->peer, core->send, message);
    (*core->env)->DeleteLocalRef(core->env, message);
    if ((*core->env)->ExceptionCheck(core->env)) { (*core->env)->ExceptionClear(core->env); return JS_ThrowInternalError(ctx, "Native message failed"); }
    return JS_UNDEFINED;
}
static JSValue sync_host(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    Core *core = JS_GetContextOpaque(ctx);
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argc ? argv[0] : JS_UNDEFINED);
    if (!text) return JS_EXCEPTION;
    jbyteArray message = bytes(core->env, text, length);
    JS_FreeCString(ctx, text);
    if (!message) return JS_ThrowInternalError(ctx, "Native message allocation failed");
    jbyteArray response = (*core->env)->CallObjectMethod(core->env, core->peer, core->sync, message);
    (*core->env)->DeleteLocalRef(core->env, message);
    if ((*core->env)->ExceptionCheck(core->env)) { (*core->env)->ExceptionClear(core->env); return JS_ThrowInternalError(ctx, "Native synchronous call failed"); }
    if (!response) return JS_ThrowInternalError(ctx, "Missing native response");
    jsize size = (*core->env)->GetArrayLength(core->env, response);
    jbyte *data = (*core->env)->GetByteArrayElements(core->env, response, NULL);
    if (!data) { (*core->env)->DeleteLocalRef(core->env, response); return JS_ThrowInternalError(ctx, "Native response allocation failed"); }
    JSValue result = JS_NewStringLen(ctx, (const char *)data, size);
    (*core->env)->ReleaseByteArrayElements(core->env, response, data, JNI_ABORT);
    (*core->env)->DeleteLocalRef(core->env, response);
    return result;
}
JNIEXPORT jlong JNICALL Java_com_yixu_reading_NativeJs_createRuntime(JNIEnv *env, jobject peer) {
    Core *core = calloc(1, sizeof(*core));
    if (!core) return 0;
    core->runtime = JS_NewRuntime();
    if (!core->runtime) { free(core); return 0; }
    JS_SetMemoryLimit(core->runtime, 96 * 1024 * 1024);
    JS_SetMaxStackSize(core->runtime, 512 * 1024);
    core->context = JS_NewContext(core->runtime);
    if (!core->context) { JS_FreeRuntime(core->runtime); free(core); return 0; }
    core->env = env; core->peer = (*env)->NewGlobalRef(env, peer);
    jclass cls = (*env)->GetObjectClass(env, peer);
    core->send = (*env)->GetMethodID(env, cls, "hostSend", "([B)V");
    core->sync = (*env)->GetMethodID(env, cls, "hostSync", "([B)[B");
    (*env)->DeleteLocalRef(env, cls);
    if (!core->peer || !core->send || !core->sync) {
        if (core->peer) (*env)->DeleteGlobalRef(env, core->peer);
        JS_FreeContext(core->context); JS_FreeRuntime(core->runtime); free(core); return 0;
    }
    JS_SetContextOpaque(core->context, core);
    JS_SetInterruptHandler(core->runtime, interrupt, core);
    JSValue global = JS_GetGlobalObject(core->context);
    JS_SetPropertyStr(core->context, global, "__hostSend", JS_NewCFunction(core->context, send_host, "__hostSend", 1));
    JS_SetPropertyStr(core->context, global, "__hostSync", JS_NewCFunction(core->context, sync_host, "__hostSync", 1));
    JS_FreeValue(core->context, global);
    return (jlong)(intptr_t)core;
}
static jbyteArray failure(JNIEnv *env, JSContext *ctx) {
    JSValue error = JS_GetException(ctx);
    JSValue stack = JS_GetPropertyStr(ctx, error, "stack");
    const char *message = JS_ToCString(ctx, error), *trace = JS_IsUndefined(stack) ? NULL : JS_ToCString(ctx, stack);
    const char *fallback = message ? message : "Native JavaScript failed";
    size_t length = strlen(fallback) + (trace ? strlen(trace) : 0) + 2;
    char *joined = malloc(length);
    jbyteArray result;
    if (joined) { snprintf(joined, length, "%s\n%s", fallback, trace ? trace : ""); result = bytes(env, joined, strlen(joined)); free(joined); }
    else result = bytes(env, fallback, strlen(fallback));
    if (message) JS_FreeCString(ctx, message);
    if (trace) JS_FreeCString(ctx, trace);
    JS_FreeValue(ctx, stack); JS_FreeValue(ctx, error);
    return result;
}
JNIEXPORT jbyteArray JNICALL Java_com_yixu_reading_NativeJs_evaluateNative(JNIEnv *env, jobject peer, jlong handle, jbyteArray input, jint limit_ms) {
    Core *core = (Core *)(intptr_t)handle;
    if (!core) return ERROR_BYTES(env, "Native runtime closed");
    core->env = env; core->deadline = now_ms() + limit_ms;
    jsize length = (*env)->GetArrayLength(env, input);
    char *code = malloc((size_t)length + 1);
    if (!code) return ERROR_BYTES(env, "Native input allocation failed");
    (*env)->GetByteArrayRegion(env, input, 0, length, (jbyte *)code); code[length] = 0;
    JSValue result = JS_Eval(core->context, code, length, "yixu-core.js", JS_EVAL_TYPE_GLOBAL);
    free(code);
    if (JS_IsException(result)) return failure(env, core->context);
    JS_FreeValue(core->context, result);
    JSContext *job_context;
    while (JS_IsJobPending(core->runtime)) {
        if (JS_ExecutePendingJob(core->runtime, &job_context) < 0) return failure(env, job_context);
        if (now_ms() > core->deadline) return ERROR_BYTES(env, "Native microtask deadline exceeded");
    }
    return NULL;
}
JNIEXPORT jbyteArray JNICALL Java_com_yixu_reading_NativeJs_statisticsNative(JNIEnv *env, jobject peer, jlong handle) {
    Core *core = (Core *)(intptr_t)handle;
    if (!core) return bytes(env, "{}", 2);
    JSMemoryUsage usage; JS_ComputeMemoryUsage(core->runtime, &usage);
    char result[200]; snprintf(result, sizeof(result), "{\"heapBytes\":%lld,\"allocatedBytes\":%lld}", (long long)usage.memory_used_size, (long long)usage.malloc_size);
    return bytes(env, result, strlen(result));
}
/* Transport data is parsed as JSON, never compiled as a giant JavaScript literal. */
JNIEXPORT jbyteArray JNICALL Java_com_yixu_reading_NativeJs_callNative(JNIEnv *env, jobject peer, jlong handle, jstring function, jbyteArray input, jint limit_ms) {
    Core *core = (Core *)(intptr_t)handle;
    if (!core) return ERROR_BYTES(env, "Native runtime closed");
    core->env = env; core->deadline = now_ms() + limit_ms;
    jsize length = (*env)->GetArrayLength(env, input);
    char *wire = malloc((size_t)length + 1);
    if (!wire) return ERROR_BYTES(env, "Native input allocation failed");
    (*env)->GetByteArrayRegion(env, input, 0, length, (jbyte *)wire); wire[length] = 0;
    JSValue args = JS_ParseJSON(core->context, wire, length, "native-arguments.json");
    free(wire);
    if (JS_IsException(args)) return failure(env, core->context);
    JSValue countValue = JS_GetPropertyStr(core->context, args, "length");
    uint32_t count = 0;
    int valid = JS_IsArray(args) && JS_ToUint32(core->context, &count, countValue) == 0 && count <= 8;
    JS_FreeValue(core->context, countValue);
    if (!valid) { JS_FreeValue(core->context, args); return ERROR_BYTES(env, "Invalid native call arguments"); }
    const char *name = (*env)->GetStringUTFChars(env, function, NULL);
    if (!name) { JS_FreeValue(core->context, args); return ERROR_BYTES(env, "Native function allocation failed"); }
    JSValue global = JS_GetGlobalObject(core->context);
    JSValue fn = JS_GetPropertyStr(core->context, global, name);
    (*env)->ReleaseStringUTFChars(env, function, name);
    JSValue argv[8];
    for (uint32_t i = 0; i < count; i++) argv[i] = JS_GetPropertyUint32(core->context, args, i);
    JSValue result = JS_Call(core->context, fn, global, count, argv);
    for (uint32_t i = 0; i < count; i++) JS_FreeValue(core->context, argv[i]);
    JS_FreeValue(core->context, fn); JS_FreeValue(core->context, global); JS_FreeValue(core->context, args);
    if (JS_IsException(result)) return failure(env, core->context);
    JS_FreeValue(core->context, result);
    JSContext *job_context;
    while (JS_IsJobPending(core->runtime)) {
        if (JS_ExecutePendingJob(core->runtime, &job_context) < 0) return failure(env, job_context);
        if (now_ms() > core->deadline) return ERROR_BYTES(env, "Native microtask deadline exceeded");
    }
    return NULL;
}
JNIEXPORT void JNICALL Java_com_yixu_reading_NativeJs_closeNative(JNIEnv *env, jobject peer, jlong handle) {
    Core *core = (Core *)(intptr_t)handle;
    if (!core) return;
    JS_FreeContext(core->context); JS_FreeRuntime(core->runtime);
    (*env)->DeleteGlobalRef(env, core->peer); free(core);
}
