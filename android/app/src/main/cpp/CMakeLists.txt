cmake_minimum_required(VERSION 3.22.1)
project(yixu_core LANGUAGES C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(QJS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../.local/vendor/quickjs/quickjs-0.17.0")
# Embed only the engine. QuickJS's optional filesystem/process modules are not linked.
add_library(yixu_core SHARED native-js.c
  "${QJS_DIR}/quickjs.c" "${QJS_DIR}/dtoa.c"
  "${QJS_DIR}/libregexp.c" "${QJS_DIR}/libunicode.c")
target_include_directories(yixu_core PRIVATE "${QJS_DIR}")
target_compile_definitions(yixu_core PRIVATE _GNU_SOURCE QUICKJS_NG_BUILD)
target_compile_options(yixu_core PRIVATE -fvisibility=hidden -funsigned-char -O2)
target_link_libraries(yixu_core m dl)
