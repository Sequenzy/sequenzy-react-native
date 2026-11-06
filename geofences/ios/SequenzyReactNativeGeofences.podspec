require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SequenzyReactNativeGeofences'
  s.version        = package['version']
  s.summary        = 'Geofencing for the Sequenzy React Native SDK.'
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Sequenzy'
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Sequenzy/sequenzy-react-native.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CoreLocation'
  s.source_files   = '*.swift'
  s.resource_bundles = { 'SequenzyReactNativeGeofencesPrivacy' => ['PrivacyInfo.xcprivacy'] }
end
