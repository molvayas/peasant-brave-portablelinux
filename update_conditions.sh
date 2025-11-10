#!/bin/bash
# Update all remaining Linux x64 stages
sed -i 's/linux-x64-build-6:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-6:\n    name: Linux x64 - Stage 6\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-5.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-5/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-7:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-7:\n    name: Linux x64 - Stage 7\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-6.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-6/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-8:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-8:\n    name: Linux x64 - Stage 8\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-7.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-7/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-9:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-9:\n    name: Linux x64 - Stage 9\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-8.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-8/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-10:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-10:\n    name: Linux x64 - Stage 10\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-9.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-9/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-11:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-11:\n    name: Linux x64 - Stage 11\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-10.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-10/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-12:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-12:\n    name: Linux x64 - Stage 12\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-11.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-11/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-13:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-13:\n    name: Linux x64 - Stage 13\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-12.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-12/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-14:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-14:\n    name: Linux x64 - Stage 14\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-13.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-13/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-15:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-15:\n    name: Linux x64 - Stage 15\/16\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-14.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-14/' .github/workflows/build-16stage.yml

sed -i 's/linux-x64-build-16:.*if: ${{ inputs\.build_linux_x64 }}/linux-x64-build-16:\n    name: Linux x64 - Stage 16\/16 (Final)\n    if: ${{ inputs.build_linux_x64 \&\& needs.linux-x64-build-15.outputs.finished != '\''true'\'' }}\n    needs: linux-x64-build-15/' .github/workflows/build-16stage.yml
