cmake_minimum_required(VERSION 3.13)
project(segi-ndk)

add_library(segi-ndk SHARED segi_ndk.cpp)

find_library(log-lib log)
target_link_libraries(segi-ndk ${log-lib})
