require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'SegiReactNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['homepage'] || 'https://github.com/bareecorporation/segi-react-native'
  s.license      = package['license'] || 'MIT'
  s.authors      = { 'Baree Corporation' => 'dev@baree.net' }
  s.platforms    = { :ios => '13.0' }
  s.source       = { :git => 'https://github.com/bareecorporation/segi-react-native.git', :tag => "v#{s.version}" }

  s.source_files = 'ios/**/*.{h,m,mm}'
  s.requires_arc = true

  s.dependency 'React-Core'
end
