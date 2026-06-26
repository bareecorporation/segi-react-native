// React Native autolinking descriptor for consumer apps.
module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        packageImportPath: 'import com.bareecorporation.segi.SegiReactNativePackage;',
        packageInstance: 'new SegiReactNativePackage()',
      },
    },
  },
};
